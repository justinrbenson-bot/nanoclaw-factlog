/**
 * Permissions guard adapter — catalog entries for the two human-admission
 * seams, composed at the module edge (imported by ./index.ts).
 *
 * channels.register — the terminal privileged operations of channel
 * registration (create wiring, create agent group, add member) are reachable
 * through two doors: the approval-card click (response handler) and the
 * free-text name reply (interceptor). Both consult this baseline with the
 * clicking/replying human as the actor: eligibility is the global chain —
 * owner / global admin — plus the specific approver the card was delivered
 * to (the D4 fix; previously the anchor was whichever agent group sorted
 * first, and the free-text door had no check at all).
 *
 * senders.admit — the unknown_sender_policy decision, verbatim: 'public'
 * allows (normally short-circuited before the gate), 'request_approval'
 * holds for the wired agent group's admin chain, 'strict' (and anything
 * unknown, fail-closed) denies.
 */
import { ALLOW, DENY, HOLD, registerGuardedAction } from '../../guard/index.js';
import { mayResolve } from '../approvals/eligibility.js';
import { getPendingChannelApproval } from './db/pending-channel-approvals.js';
import { SENDER_ADMIT_ACTION } from './sender-approval.js';

registerGuardedAction({
  action: 'channels.register',
  baseline: (input) => {
    if (input.actor.kind !== 'human' || !input.actor.userId) {
      return DENY('channel registration is resolved by a human approver');
    }
    const messagingGroupId = typeof input.payload.questionId === 'string' ? input.payload.questionId : '';
    const row = getPendingChannelApproval(messagingGroupId);
    if (!row) {
      return DENY(`no pending channel registration for ${messagingGroupId}`);
    }
    return mayResolve(
      { kind: 'admins-of-scope', agentGroupId: null, deliveredTo: row.approver_user_id },
      'group',
      input.actor.userId,
    )
      ? ALLOW('eligible channel-registration approver')
      : DENY('not an eligible channel-registration approver (owner / global admin)');
  },
});

registerGuardedAction({
  action: 'senders.admit',
  approvalAction: SENDER_ADMIT_ACTION,
  baseline: (input) => {
    const policy = input.payload.policy;
    if (policy === 'public') return ALLOW('public messaging group');
    if (policy === 'request_approval') {
      return HOLD(
        {
          kind: 'admins-of-scope',
          agentGroupId: (input.payload.agentGroupId as string | undefined) ?? null,
          deliveredTo: null,
        },
        'group',
        'unknown sender requires admission approval',
      );
    }
    return DENY(`unknown sender (policy ${String(policy)})`);
  },
});
