/** Approve handler for a held a2a message. (Reject is handled by the generic response-handler path.) */
import { log } from '../../log.js';
import type { ApprovalHandler } from '../approvals/index.js';
import { routeAgentMessage, type RoutableAgentMessage } from './agent-route.js';

export const applyA2aMessageGate: ApprovalHandler = async ({ session, payload, approval, notify }) => {
  if (!session) {
    log.warn('a2a_message_gate approval resolved without a session — dropping');
    return;
  }
  const { id, platform_id, content, in_reply_to } = payload;
  if (typeof platform_id !== 'string' || !platform_id) {
    notify('Message approved but the target agent group was missing from the request.');
    log.warn('a2a_message_gate apply: missing target', { sessionId: session.id });
    return;
  }

  const msg: RoutableAgentMessage = {
    id: typeof id === 'string' ? id : `a2a-gate-${Date.now()}`,
    platform_id,
    content: typeof content === 'string' ? content : '',
    in_reply_to: typeof in_reply_to === 'string' ? in_reply_to : null,
  };

  // One replay semantics (D3): re-enter the guarded route carrying the
  // approval row as the grant. The policy hold is satisfied, but the
  // structural baseline runs live — un-wiring the pair between hold and
  // approve now blocks delivery (the throw surfaces via the response
  // handler's "approved, but applying it failed" notify).
  await routeAgentMessage(msg, session, { grant: approval });
  log.info('Held agent message delivered after approval', {
    from: session.agent_group_id,
    to: platform_id,
    msgId: msg.id,
  });
};
