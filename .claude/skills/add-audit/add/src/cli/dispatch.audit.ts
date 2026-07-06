/**
 * CLI audit adapter (installed by /add-audit) — owns how the dispatcher
 * describes itself to the audit log: the dispatch middleware plus the
 * CLI-specific actor/origin/resource mapping. Composed in dispatch.ts as
 * `export const dispatch = withAudit(dispatchInner)`; business logic there
 * contains zero audit calls.
 */
import { emitAuditEvent } from '../audit/emit.js';
import { hostUser } from '../audit/vocab.js';
import { containerOrigin } from '../audit/vocab.js';
import { type AuditActor, type AuditOrigin, type AuditOutcome, type AuditResource } from '../audit/types.js';
import { getResource } from './crud.js';
import type { CallerContext, RequestFrame, ResponseFrame } from './frame.js';
import type { CommandDef } from './registry.js';
// Type-only import from the module this adapter wraps — erased at runtime,
// so dispatch.ts importing this file back is not a cycle.
import type { DispatchOptions, DispatchTrace } from './dispatch.js';

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

// ── The dispatch middleware ──

type DispatchInner = (req: RequestFrame, ctx: CallerContext, opts?: DispatchOptions) => Promise<ResponseFrame>;

/**
 * Dispatch middleware — the exported `dispatch` is the wrapped function, so
 * the socket server, the container delivery-action, and the approved replay
 * are all covered without changing a call site.
 *
 * Outcome derives from the response frame: ok → success, forbidden → denied
 * (captures pre-handler scope denials), anything else → failure.
 * approval-pending responses are skipped — the requestApproval decorator owns
 * every pending event. On replays, opts.approvalId becomes the terminal
 * event's correlation_id.
 */
export function withAudit(inner: DispatchInner): DispatchInner {
  return async (req, ctx, opts = {}) => {
    // Trace out-param: dispatch reassigns `req` internally (dash-id fallback,
    // group auto-fill), so the resolved command + effective args surface here.
    const trace: DispatchTrace = {};
    const res = await inner(req, ctx, { ...opts, trace });

    if (!res.ok && res.error.code === 'approval-pending') return res;

    emitAuditEvent(() => {
      const cmd = trace.cmd;
      const args = normalizeArgKeys(trace.args ?? req.args);
      const outcome: AuditOutcome = res.ok ? 'success' : res.error.code === 'forbidden' ? 'denied' : 'failure';
      const details: Record<string, unknown> = { ...args };
      if (!res.ok) {
        details.error = res.error.code;
        details.reason = res.error.message;
      }
      if (!cmd) details.command = trace.command ?? req.command;
      return {
        actor: actorForCaller(ctx),
        origin: originForCaller(ctx),
        action: cmd ? cmd.action : 'cli.unknown-command',
        resources: cmd ? resourcesForCli(cmd, args) : [],
        outcome,
        correlationId: opts.approvalId ?? null,
        details,
      };
    });
    return res;
  };
}
