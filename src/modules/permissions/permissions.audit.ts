/**
 * Permissions audit adapter — senders.allow and
 * channels.register events for the card/interceptor stack that never touches
 * the approvals primitive. The inner handlers return domain decision
 * descriptors (SenderApprovalResult / ChannelApprovalResult, defined with the
 * handlers); these adapters emit the event and coerce back to the boolean the
 * response registry / router expect.
 */
import { emitAuditEvent } from '../../audit/emit.js';
import type { AuditResource } from '../../audit/types.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { ResponsePayload } from '../../response-registry.js';
// Type-only import from the module this adapter wraps — erased at runtime,
// so permissions/index.ts importing this file back is not a cycle.
import type { ChannelApprovalResult, ChannelDecision, SenderApprovalResult } from './index.js';

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
