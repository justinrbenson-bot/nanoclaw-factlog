/**
 * Audit wrapper factories — the only way audit events get emitted. Each
 * instrumented seam composes one of these at its module edge; business logic
 * stays free of audit calls.
 */
import type { InboundEvent } from '../channels/adapter.js';
import type { CallerContext, RequestFrame, ResponseFrame } from '../cli/frame.js';
import type { DispatchOptions, DispatchTrace } from '../cli/dispatch.js';
import { getPendingApproval } from '../db/sessions.js';
// Type-only imports from the approvals module — erased at runtime, so
// primitive.ts importing this file back is not a cycle.
import type {
  ApprovalHandler,
  ApprovalHandlerContext,
  ApprovalHold,
  RequestApprovalOptions,
} from '../modules/approvals/primitive.js';
import type { CreateAgentResult } from '../modules/agent-to-agent/create-agent.js';
import type { ResponsePayload } from '../response-registry.js';
import type { AgentGroup, PendingApproval, Session } from '../types.js';
import { emitAuditEvent } from './emit.js';
import {
  actorForCaller,
  auditActionForApproval,
  channelOriginForUser,
  detailsForApprovalPayload,
  humanOrSystemActor,
  normalizeArgKeys,
  oneCliDecideEvent,
  oneCliHoldEvent,
  originForCaller,
  originForSession,
  resourcesForApproval,
  resourcesForCli,
} from './mapping.js';
import { type AuditOutcome, type AuditResource, SYSTEM_ACTOR } from './types.js';

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

type RequestApprovalInner = (opts: RequestApprovalOptions) => Promise<ApprovalHold | null>;

/**
 * requestApproval decorator — owns every pending event, for all gated
 * surfaces at once: only this seam holds the action, payload, minted approval
 * id, and the approver the card actually went to. No hold (no approver, no DM
 * target, delivery failure) → no event.
 */
export function auditRequestApproval(inner: RequestApprovalInner): (opts: RequestApprovalOptions) => Promise<void> {
  return async (opts) => {
    const hold = await inner(opts);
    if (!hold) return;
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
  };
}

/**
 * Post-approve handler runner — emits the terminal event of a gated chain
 * (success/failure from whether the handler threw), correlated by the
 * approval id. cli_command is skipped: its replay goes back through the
 * dispatch middleware, which alone sees the real response frame. Rethrows so
 * the response handler's own catch/notify behavior is unchanged.
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

// ── Permissions card handlers (senders.allow / channels.register) ──
// The inner handlers return domain descriptors; these adapters emit the event
// and coerce back to the boolean the response registry / router expect.

export interface SenderDecision {
  approved: boolean;
  senderIdentity: string;
  agentGroupId: string;
  messagingGroupId: string;
  approverId: string;
  channelType: string;
}
export type SenderApprovalResult = { claimed: boolean; decision?: SenderDecision };

export function auditSenderDecision(
  inner: (payload: ResponsePayload) => Promise<SenderApprovalResult>,
): (payload: ResponsePayload) => Promise<boolean> {
  return async (payload) => {
    const result = await inner(payload);
    const d = result.decision;
    if (d) {
      emitAuditEvent(() => ({
        actor: { type: 'human', id: d.approverId },
        origin: { transport: 'channel', channel: d.channelType || undefined },
        action: 'senders.allow',
        resources: [
          { type: 'user', id: d.senderIdentity },
          { type: 'agent_group', id: d.agentGroupId },
          { type: 'messaging_group', id: d.messagingGroupId },
        ],
        outcome: d.approved ? 'success' : 'rejected',
        // The withheld message is never read here — ids only.
        details: {},
      }));
    }
    return result.claimed;
  };
}

export interface ChannelDecision {
  kind: 'connected' | 'rejected' | 'failed';
  messagingGroupId: string;
  approverId: string;
  channelType?: string;
  agentGroupId?: string;
  createdAgentGroup?: boolean;
  agentName?: string;
  reason?: string;
}
export type ChannelApprovalResult = { claimed: boolean; decision?: ChannelDecision };

function emitChannelDecision(d: ChannelDecision): void {
  emitAuditEvent(() => {
    const resources: AuditResource[] = [{ type: 'messaging_group', id: d.messagingGroupId }];
    if (d.agentGroupId) resources.push({ type: 'agent_group', id: d.agentGroupId });
    const details: Record<string, unknown> = {};
    if (d.createdAgentGroup !== undefined) details.created_agent_group = d.createdAgentGroup;
    if (d.agentName) details.agent_name = d.agentName;
    if (d.reason) details.reason = d.reason;
    return {
      actor: { type: 'human', id: d.approverId },
      origin: { transport: 'channel', channel: d.channelType || undefined },
      action: 'channels.register',
      resources,
      outcome: d.kind === 'connected' ? 'success' : d.kind === 'rejected' ? 'rejected' : 'failure',
      details,
    };
  });
}

export function auditChannelDecision(
  inner: (payload: ResponsePayload) => Promise<ChannelApprovalResult>,
): (payload: ResponsePayload) => Promise<boolean> {
  return async (payload) => {
    const result = await inner(payload);
    if (result.decision) emitChannelDecision(result.decision);
    return result.claimed;
  };
}

/** The free-text name reply — the third agent-creation door (new group + wiring). */
export function auditChannelNameInterceptor(
  inner: (event: InboundEvent) => Promise<ChannelApprovalResult>,
): (event: InboundEvent) => Promise<boolean> {
  return async (event) => {
    const result = await inner(event);
    if (result.decision) emitChannelDecision(result.decision);
    return result.claimed;
  };
}

// ── agents.create — the ungated door ──

type PerformCreateAgentFn = (
  name: string,
  instructions: string | null,
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => void,
) => Promise<CreateAgentResult>;

/**
 * Wraps ONLY the global-scope direct call. The approval-gated path is covered
 * by the pending/decide/terminal chain (runApprovedHandler wraps
 * applyCreateAgent's run) — wrapping the shared body would double-emit.
 */
export function auditCreateAgentDirect(inner: PerformCreateAgentFn): PerformCreateAgentFn {
  return async (name, instructions, session, sourceGroup, notify) => {
    const result = await inner(name, instructions, session, sourceGroup, notify);
    emitAuditEvent(() => {
      const resources: AuditResource[] = [{ type: 'agent_group', id: sourceGroup.id }];
      const details: Record<string, unknown> = {
        name,
        parent: sourceGroup.id,
        instructions_chars: instructions ? instructions.length : 0,
      };
      if (result.ok) {
        resources.push({ type: 'agent_group', id: result.agentGroupId });
        details.folder = result.folder;
      } else {
        details.reason = result.reason;
      }
      return {
        actor: { type: 'agent', id: session.agent_group_id },
        origin: originForSession(session),
        action: 'agents.create',
        resources,
        outcome: result.ok ? 'success' : 'failure',
        details,
      };
    });
    return result;
  };
}

// ── OneCLI credential approvals (hold + three resolution paths) ──

interface OneCliHoldRow {
  approval_id: string;
  agent_group_id?: string | null;
  payload: string;
}

/** Wraps the hold's row insert — emits the pending event derived from the row. */
export function auditOneCliHold<T extends OneCliHoldRow>(inner: (row: T) => void): (row: T) => void {
  return (row) => {
    inner(row);
    emitAuditEvent(() => oneCliHoldEvent(row));
  };
}

/**
 * Wraps the card-click resolver. The resolving human's id arrives here (the
 * inner resolver has no use for it); the row is pre-read because the inner
 * deletes it on resolution.
 */
export function auditOneCliDecision(
  inner: (approvalId: string, selectedOption: string) => boolean,
): (approvalId: string, selectedOption: string, userId: string) => boolean {
  return (approvalId, selectedOption, userId) => {
    const row = getPendingApproval(approvalId);
    const resolved = inner(approvalId, selectedOption);
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
