/**
 * Decision events — approvals.decide, one per resolved approval, riding the
 * existing approval-resolved hook. Covers every requestApproval-backed action
 * (cli_command, self-mod, create_agent, a2a gate); OneCLI never reaches
 * notifyApprovalResolved and emits its decisions from its own wrappers.
 */
// Direct file import (not the approvals barrel) to keep the graph tight.
import { type ApprovalResolvedEvent, registerApprovalResolvedHandler } from '../modules/approvals/primitive.js';
import { emitAuditEvent } from './emit.js';
import { auditActionForApproval, channelOriginForUser, humanOrSystemActor, resourcesForApproval } from './mapping.js';

export function onApprovalResolved(event: ApprovalResolvedEvent): void {
  emitAuditEvent(() => {
    const payload = safeParse(event.approval.payload);
    return {
      // '' resolver = sweep/timer (e.g. the awaiting-reason ghost sweep) → system.
      actor: humanOrSystemActor(event.userId),
      // Decisions are card clicks on a chat platform, even system-finalized
      // ones — the card lifecycle is the surface.
      origin: channelOriginForUser(event.userId),
      action: 'approvals.decide',
      resources: [
        ...resourcesForApproval(event.approval.action, payload, event.session),
        { type: 'approval', id: event.approval.approval_id },
      ],
      outcome: event.outcome === 'approve' ? 'approved' : 'rejected',
      correlationId: event.approval.approval_id,
      details: {
        gated_action: auditActionForApproval(event.approval.action, payload),
        requested_by: event.session.agent_group_id,
      },
    };
  });
}

export function registerAuditObserver(): void {
  registerApprovalResolvedHandler(onApprovalResolved);
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    // eslint-disable-next-line no-catch-all/no-catch-all -- stored payloads are untrusted; a malformed one must not break the decision event
  } catch {
    return {};
  }
}
