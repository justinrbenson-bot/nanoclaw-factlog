/**
 * CLI audit adapter (installed by /add-audit) — owns how the dispatcher
 * describes itself to the audit log: the dispatch middleware plus the
 * CLI-specific actor/origin/resource mapping. Composed in dispatch.ts as
 * `export const dispatch = withAudit(dispatchInner)`; business logic there
 * contains zero audit calls.
 *
 * Loading this module also boots the audit log (writability assert, boot
 * prune, hook lifecycle, maintenance timer): dispatch.ts is imported by both
 * transports during the host's barrel phase, so initAuditLog() runs before
 * any command is accepted — and an enabled box with an unwritable
 * data/audit/ refuses to start.
 */
import { emitAuditEvent } from '../audit/emit.js';
import { initAuditLog } from '../audit/init.js';
import { type AuditActor, type AuditOrigin, type AuditOutcome, type AuditResource } from '../audit/types.js';
import { containerOrigin, hostUser } from '../audit/vocab.js';
import { getContainerConfig } from '../db/container-configs.js';
import { getPendingApprovalsByAction } from '../db/sessions.js';
import type { PendingApproval } from '../types.js';
import { getResource } from './crud.js';
import type { CallerContext, RequestFrame, ResponseFrame } from './frame.js';
import { type CommandDef, lookup } from './registry.js';

initAuditLog();

// ── CLI mapping ──

/**
 * Host callers stamp `host:<install user>` daemon-side (the ncl socket is
 * 0600 and owned by the install user); container callers are their agent group.
 */
export function actorForCaller(ctx: CallerContext): AuditActor {
  return ctx.caller === 'host' ? { type: 'human', id: `host:${hostUser()}` } : { type: 'agent', id: ctx.agentGroupId };
}

export function originForCaller(ctx: CallerContext): AuditOrigin {
  if (ctx.caller === 'host') return { transport: 'socket' };
  return containerOrigin(ctx.sessionId, ctx.messagingGroupId || null);
}

/**
 * Frame-level args use `--hyphen-keys`; recorded details use the same
 * underscore form the parsed handlers see. Mirrors crud's normalizeArgs
 * (kept local so audit doesn't depend on a module tests commonly mock).
 */
export function normalizeArgKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k.replace(/-/g, '_')] = v;
  }
  return out;
}

/** CLI resource plural → audit resource type, where the singular isn't it. */
const RESOURCE_TYPE_OVERRIDES: Record<string, string> = {
  groups: 'agent_group',
  'messaging-groups': 'messaging_group',
  'dropped-messages': 'dropped_message',
  'user-dms': 'user_dm',
};

/**
 * Derive touched/attempted resources from a command's effective args. Generic
 * by design: `id` → the command's own resource, group/user args → their
 * types, and a bare `{type}` entry when nothing else is known (a denied
 * `users list` still names what was attempted).
 */
export function resourcesForCli(cmd: CommandDef, args: Record<string, unknown>): AuditResource[] {
  if (!cmd.resource) return [];
  const type = RESOURCE_TYPE_OVERRIDES[cmd.resource] ?? getResource(cmd.resource)?.name ?? cmd.resource;

  const out: AuditResource[] = [];
  const push = (t: string, id: unknown): void => {
    if (typeof id !== 'string' || !id) return;
    if (!out.some((r) => r.type === t && r.id === id)) out.push({ type: t, id });
  };
  push(type, args.id);
  push('agent_group', args.agent_group_id ?? args.group);
  push('user', args.user);
  if (out.length === 0) out.push({ type });
  return out;
}

// ── Dispatch mechanics, mirrored for the record ──
// Dispatch resolves the command and auto-fills args on a local copy of the
// frame that never leaves it, so the middleware mirrors the two documented
// mechanics below. The copies are mechanical, and drift only ever degrades a
// record's detail (a fallback action name, a missing auto-filled arg) — never
// dispatch behavior, and never an outcome.

/**
 * Mirror of dispatch's command resolution: exact lookup, then the longest
 * registered dash-prefix with the remainder recorded as --id.
 */
function resolveForRecord(req: RequestFrame): { cmd?: CommandDef; args: Record<string, unknown> } {
  const direct = lookup(req.command);
  if (direct) return { cmd: direct, args: req.args };
  let shortened = req.command;
  let idx: number;
  while ((idx = shortened.lastIndexOf('-')) > 0) {
    shortened = shortened.slice(0, idx);
    const fallback = lookup(shortened);
    if (fallback) {
      const tail = req.command.slice(shortened.length + 1);
      return { cmd: fallback, args: { ...req.args, id: req.args.id ?? tail } };
    }
  }
  return { args: req.args };
}

/**
 * Mirror of dispatch's group-scope arg auto-fill, so the record shows the
 * effective args the handler saw (e.g. which agent group a bare
 * `sessions list` actually listed).
 */
function effectiveArgs(
  cmd: CommandDef | undefined,
  args: Record<string, unknown>,
  ctx: CallerContext,
): Record<string, unknown> {
  if (ctx.caller !== 'agent') return args;
  if ((getContainerConfig(ctx.agentGroupId)?.cli_scope ?? 'group') !== 'group') return args;
  const fill: Record<string, unknown> = {
    agent_group_id: args.agent_group_id ?? ctx.agentGroupId,
    group: args.group ?? ctx.agentGroupId,
  };
  if (cmd?.resource === 'groups' || cmd?.resource === 'destinations') {
    fill.id = args.id ?? ctx.agentGroupId;
  }
  return { ...args, ...fill };
}

/**
 * CLI args arrive as strings, so a JSON-object/array value (e.g.
 * `--env '{"NOTION_TOKEN":"…"}'`) would reach the redactor as one opaque
 * string under an innocent key and its inner secret keys would survive.
 * Recording the parsed form lets the redactor walk inside — the audit log's
 * "secrets never land" property depends on it for exactly this flow.
 */
function parseJsonishValues(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
      try {
        out[k] = JSON.parse(v);
        continue;
        // eslint-disable-next-line no-catch-all/no-catch-all -- not JSON after all: record the string as-is
      } catch {
        /* fall through */
      }
    }
    out[k] = v;
  }
  return out;
}

/**
 * The approval row a hold just created for this frame — it gives the pending
 * event the same correlation_id the approved replay will carry as its guard
 * grant. requestApproval keeps the minted id internal, so the row is
 * recovered by the frame id it stored in its payload; no row (e.g. no
 * configured approver) → the hold is still recorded, uncorrelated.
 */
function holdApprovalIdFor(frameId: string): string | null {
  const rows = getPendingApprovalsByAction('cli_command');
  for (let i = rows.length - 1; i >= 0; i--) {
    try {
      const payload = JSON.parse(rows[i].payload) as { frame?: { id?: string } };
      if (payload.frame?.id === frameId) return rows[i].approval_id;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a row with an unparseable payload is simply not this frame's hold
    } catch {
      continue;
    }
  }
  return null;
}

// ── The dispatch middleware ──

type DispatchInner = (
  req: RequestFrame,
  ctx: CallerContext,
  opts?: { grant?: PendingApproval },
) => Promise<ResponseFrame>;

/**
 * Dispatch middleware — the exported `dispatch` is the wrapped function, so
 * the socket server, the container delivery-action, and the in-module
 * approved replay are all covered by the one composition.
 *
 * Outcome derives from the response frame: ok → success, forbidden → denied
 * (captures pre-handler scope denials), approval-pending → pending (the
 * record of a hold), anything else → failure. Correlation is the approval id:
 * an approved replay carries the approval row as its guard grant
 * (opts.grant), and a fresh hold is correlated by recovering the row it just
 * created — so `--correlation <approval-id>` returns the whole gated chain.
 */
export function withAudit(inner: DispatchInner): DispatchInner {
  return async (req, ctx, opts = {}) => {
    const res = await inner(req, ctx, opts);
    emitAuditEvent(() => {
      const resolved = resolveForRecord(req);
      const cmd = resolved.cmd;
      const pending = !res.ok && res.error.code === 'approval-pending';
      const outcome: AuditOutcome = res.ok
        ? 'success'
        : res.error.code === 'forbidden'
          ? 'denied'
          : pending
            ? 'pending'
            : 'failure';
      // A denial records the attempt as asked (raw args): nothing ran, so the
      // auto-fill never conceptually happened — and a cross-group attempt
      // must show the foreign id the caller passed, not a filled-in own-group.
      const args = normalizeArgKeys(outcome === 'denied' ? resolved.args : effectiveArgs(cmd, resolved.args, ctx));
      const correlationId = opts.grant?.approval_id ?? (pending ? holdApprovalIdFor(req.id) : null);
      const details: Record<string, unknown> = parseJsonishValues(args);
      if (!res.ok && !pending) {
        details.error = res.error.code;
        details.reason = res.error.message;
      }
      if (!cmd) details.command = req.command;
      const resources = cmd ? resourcesForCli(cmd, args) : [];
      if (correlationId) resources.push({ type: 'approval', id: correlationId });
      return {
        actor: actorForCaller(ctx),
        origin: originForCaller(ctx),
        action: cmd ? (cmd.action ?? `cli.${cmd.name}`) : 'cli.unknown-command',
        resources,
        outcome,
        correlationId,
        details,
      };
    });
    return res;
  };
}
