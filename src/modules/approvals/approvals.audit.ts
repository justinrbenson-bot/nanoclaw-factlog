/**
 * Approvals audit adapter — owns how the approvals
 * domain describes itself to the audit log: the requestApproval decorator
 * (every gated hold → pending event), the post-approve handler runner (the
 * gated chain's terminal event), the OneCLI credential wrappers (hold + three
 * resolution paths), and the approval-payload mapping they share. Composed at
 * this module's edges; business logic contains zero audit calls.
 */
import { emitAuditEvent } from '../../audit/emit.js';
import {
  type AuditActor,
  type AuditEventInput,
  type AuditOrigin,
  type AuditOutcome,
  type AuditResource,
  SYSTEM_ACTOR,
} from '../../audit/types.js';
import { channelOriginForUser, humanOrSystemActor, originForSession } from '../../audit/vocab.js';
import { resourcesForCli } from '../../cli/dispatch.audit.js';
import type { RequestFrame } from '../../cli/frame.js';
import { lookup } from '../../cli/registry.js';
import { getPendingApproval } from '../../db/sessions.js';
import type { PendingApproval, Session } from '../../types.js';
// Type-only imports from the module this adapter wraps — erased at runtime,
// so primitive.ts importing this file back is not a cycle.
import type { ApprovalHandler, ApprovalHandlerContext, ApprovalHold, RequestApprovalOptions } from './primitive.js';

// ── Approval-payload mapping ──

/** Dotted audit action per approval type; cli_command derives from its frame. */
export const APPROVAL_AUDIT_ACTIONS: Record<string, string> = {
  install_packages: 'self-mod.install-packages',
  add_mcp_server: 'self-mod.add-mcp-server',
  create_agent: 'agents.create',
  a2a_message_gate: 'messages.a2a-gate',
  onecli_credential: 'onecli.credential.use',
};

export function auditActionForApproval(approvalAction: string, payload: Record<string, unknown>): string {
  if (approvalAction === 'cli_command') {
    const frame = payload.frame as RequestFrame | undefined;
    return (frame && lookup(frame.command)?.action) ?? 'cli.unknown-command';
  }
  return APPROVAL_AUDIT_ACTIONS[approvalAction] ?? approvalAction.replace(/_/g, '.');
}

/**
 * details for an approval's pending/terminal events. Message-bearing payloads
 * (a2a gate) record shape only — body_chars and attachment names, never
 * content; the emit-seam redactor is defense-in-depth, not the mechanism.
 */
export function detailsForApprovalPayload(
  approvalAction: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (approvalAction) {
    case 'cli_command': {
      const frame = payload.frame as RequestFrame | undefined;
      return { ...(frame?.args ?? {}) };
    }
    case 'create_agent': {
      const instructions = typeof payload.instructions === 'string' ? payload.instructions : null;
      return { name: payload.name, instructions_chars: instructions ? instructions.length : 0 };
    }
    case 'a2a_message_gate': {
      const { text, files } = messageShape(payload.content);
      return { to: payload.platform_id, body_chars: text.length, attachments: files };
    }
    default:
      // install_packages, add_mcp_server, and future types: metadata payloads
      // pass through as-is — the emit-seam redactor masks sensitive keys.
      return { ...payload };
  }
}

export function resourcesForApproval(
  approvalAction: string,
  payload: Record<string, unknown>,
  session: Session,
): AuditResource[] {
  const base: AuditResource[] = [{ type: 'agent_group', id: session.agent_group_id }];
  if (approvalAction === 'cli_command') {
    const frame = payload.frame as RequestFrame | undefined;
    const cmd = frame && lookup(frame.command);
    if (cmd && frame) {
      const cliResources = resourcesForCli(cmd, frame.args);
      for (const r of cliResources) {
        if (!base.some((b) => b.type === r.type && b.id === r.id)) base.push(r);
      }
    }
  }
  if (approvalAction === 'a2a_message_gate' && typeof payload.platform_id === 'string' && payload.platform_id) {
    if (payload.platform_id !== session.agent_group_id) {
      base.push({ type: 'agent_group', id: payload.platform_id });
    }
  }
  return base;
}

/** Mirror of agent-route's message-content parse — shape extraction only. */
function messageShape(content: unknown): { text: string; files: string[] } {
  if (typeof content !== 'string') return { text: '', files: [] };
  try {
    const parsed = JSON.parse(content) as { text?: unknown; files?: unknown };
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      files: Array.isArray(parsed.files) ? parsed.files.filter((f): f is string => typeof f === 'string') : [],
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- non-JSON content is the raw body; shape extraction must not throw
  } catch {
    return { text: content, files: [] };
  }
}

// ── requestApproval decorator ──

type RequestApprovalFn = (opts: RequestApprovalOptions) => Promise<ApprovalHold | null>;

/**
 * requestApproval decorator — owns every pending event, for all gated
 * surfaces at once: only this seam holds the action, payload, minted approval
 * id, and the approver the card actually went to. Pass-through: callers see
 * the hold exactly as the inner returns it. No hold → no event.
 */
export function auditRequestApproval(inner: RequestApprovalFn): RequestApprovalFn {
  return async (opts) => {
    const hold = await inner(opts);
    if (!hold) return hold;
    emitAuditEvent(() => ({
      actor: { type: 'agent', id: opts.session.agent_group_id },
      origin: originForSession(opts.session),
      action: auditActionForApproval(opts.action, opts.payload),
      resources: [
        ...resourcesForApproval(opts.action, opts.payload, opts.session),
        { type: 'approval', id: hold.approvalId },
        // Who was asked: the picked approver is part of the record.
        { type: 'user', id: hold.approverUserId },
      ],
      outcome: 'pending',
      correlationId: hold.approvalId,
      details: detailsForApprovalPayload(opts.action, opts.payload),
    }));
    return hold;
  };
}

// ── Post-approve handler runner ──

/**
 * Emits the terminal event of a gated chain (success/failure from whether the
 * handler threw), correlated by the approval id. cli_command is skipped: its
 * replay goes back through the dispatch middleware, which alone sees the real
 * response frame. Rethrows so the response handler's own catch/notify
 * behavior is unchanged.
 */
export async function runApprovedHandler(
  handler: ApprovalHandler,
  ctx: ApprovalHandlerContext,
  approval: PendingApproval,
  session: Session,
): Promise<void> {
  const skip = approval.action === 'cli_command';
  const terminal = (outcome: AuditOutcome, error?: string): void => {
    if (skip) return;
    emitAuditEvent(() => ({
      actor: { type: 'agent', id: session.agent_group_id },
      origin: originForSession(session),
      action: auditActionForApproval(approval.action, ctx.payload),
      resources: [
        ...resourcesForApproval(approval.action, ctx.payload, session),
        { type: 'approval', id: approval.approval_id },
      ],
      outcome,
      correlationId: approval.approval_id,
      details: error
        ? { ...detailsForApprovalPayload(approval.action, ctx.payload), error }
        : detailsForApprovalPayload(approval.action, ctx.payload),
    }));
  };

  try {
    await handler(ctx);
  } catch (err) {
    terminal('failure', err instanceof Error ? err.message : String(err));
    throw err;
  }
  terminal('success');
}

// ── OneCLI credential approvals (hold + three resolution paths) ──

/** = APPROVAL_AUDIT_ACTIONS.onecli_credential; named for the OneCLI wrappers. */
export const ONECLI_AUDIT_ACTION = 'onecli.credential.use';

interface OneCliRowShape {
  approval_id: string;
  agent_group_id?: string | null;
  payload: string;
}

interface OneCliPayload {
  oneCliRequestId?: string;
  method?: string;
  host?: string;
  path?: string;
  bodyPreview?: string;
  agent?: { externalId?: string | null; name?: string };
  approver?: string;
}

function oneCliPayload(row: OneCliRowShape): OneCliPayload {
  try {
    const parsed: unknown = JSON.parse(row.payload);
    return parsed && typeof parsed === 'object' ? (parsed as OneCliPayload) : {};
    // eslint-disable-next-line no-catch-all/no-catch-all -- stored payloads are untrusted; a malformed one must not break event assembly
  } catch {
    return {};
  }
}

/** Shape-only: the request body's presence is auditable, its content never is. */
function oneCliDetails(p: OneCliPayload): Record<string, unknown> {
  return {
    method: p.method,
    host: p.host,
    path: p.path,
    one_cli_request_id: p.oneCliRequestId,
    body_preview_chars: typeof p.bodyPreview === 'string' ? p.bodyPreview.length : 0,
  };
}

function oneCliResources(row: OneCliRowShape): AuditResource[] {
  const out: AuditResource[] = [];
  if (row.agent_group_id) out.push({ type: 'agent_group', id: row.agent_group_id });
  out.push({ type: 'approval', id: row.approval_id });
  return out;
}

/** Pending event for a OneCLI credential hold, derived from its row. */
export function oneCliHoldEvent(row: OneCliRowShape): AuditEventInput {
  const p = oneCliPayload(row);
  const resources = oneCliResources(row);
  if (p.approver) resources.push({ type: 'user', id: p.approver });
  return {
    actor: { type: 'agent', id: row.agent_group_id ?? p.agent?.externalId ?? p.agent?.name ?? 'unknown' },
    // OneCLI requests come from inside an agent container but carry no session.
    origin: { transport: 'container' },
    action: ONECLI_AUDIT_ACTION,
    resources,
    outcome: 'pending',
    correlationId: row.approval_id,
    details: oneCliDetails(p),
  };
}

/** approvals.decide for a OneCLI resolution (click, expiry, or startup sweep). */
export function oneCliDecideEvent(
  row: OneCliRowShape & { channel_type?: string | null },
  args: { actor: AuditActor; origin: AuditOrigin; outcome: 'approved' | 'rejected'; reason?: string },
): AuditEventInput {
  const details: Record<string, unknown> = {
    gated_action: ONECLI_AUDIT_ACTION,
    ...oneCliDetails(oneCliPayload(row)),
  };
  if (args.reason) details.reason = args.reason;
  return {
    actor: args.actor,
    origin: args.origin,
    action: 'approvals.decide',
    resources: oneCliResources(row),
    outcome: args.outcome,
    correlationId: row.approval_id,
    details,
  };
}

/** Wraps the hold's row insert — emits the pending event derived from the row. */
export function auditOneCliHold<T extends OneCliRowShape>(inner: (row: T) => void): (row: T) => void {
  return (row) => {
    inner(row);
    emitAuditEvent(() => oneCliHoldEvent(row));
  };
}

/**
 * Wraps the card-click resolver. The row is pre-read because the inner
 * deletes it on resolution; `userId` is the resolving admin (already part of
 * the resolver's contract — empty means a timer/sweep, i.e. the system).
 */
export function auditOneCliDecision(
  inner: (approvalId: string, selectedOption: string, userId: string) => boolean,
): (approvalId: string, selectedOption: string, userId: string) => boolean {
  return (approvalId, selectedOption, userId) => {
    const row = getPendingApproval(approvalId);
    const resolved = inner(approvalId, selectedOption, userId);
    if (resolved && row) {
      emitAuditEvent(() =>
        oneCliDecideEvent(row, {
          actor: humanOrSystemActor(userId),
          origin: channelOriginForUser(userId),
          outcome: selectedOption === 'approve' ? 'approved' : 'rejected',
        }),
      );
    }
    return resolved;
  };
}

/** Wraps the expiry timer's finalizer — the system actor rejects. */
export function auditOneCliExpiry(
  inner: (approvalId: string, reason: string) => Promise<void>,
): (approvalId: string, reason: string) => Promise<void> {
  return async (approvalId, reason) => {
    const row = getPendingApproval(approvalId);
    await inner(approvalId, reason);
    if (row) {
      emitAuditEvent(() =>
        oneCliDecideEvent(row, {
          actor: SYSTEM_ACTOR,
          origin: { transport: 'channel', channel: row.channel_type ?? undefined },
          outcome: 'rejected',
          reason: `expired: ${reason}`,
        }),
      );
    }
  };
}

/** Wraps the startup sweep — one system rejection per orphaned row. */
export function auditOneCliSweep(inner: () => Promise<void>, listRows: () => PendingApproval[]): () => Promise<void> {
  return async () => {
    const rows = listRows();
    await inner();
    for (const row of rows) {
      emitAuditEvent(() =>
        oneCliDecideEvent(row, {
          actor: SYSTEM_ACTOR,
          origin: { transport: 'channel', channel: row.channel_type ?? undefined },
          outcome: 'rejected',
          reason: 'host restarted',
        }),
      );
    }
  };
}
