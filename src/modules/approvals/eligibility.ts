/**
 * Approver eligibility — the one click-authorization rule for every hold.
 *
 * The hold-record contract (guarded-actions phase 1) is carried on the
 * existing tables: a hold has an id, an action, a payload, an eligibility
 * rule (who may resolve it), an approver scope (the action's blast radius),
 * a restart policy, and an optional expiry. On `pending_approvals` these map
 * to `approval_id` / `action` / `payload` / (`eligibility` +
 * `approver_user_id` + `agent_group_id`) / `approver_scope` / `expires_at`;
 * the restart policy is derived from the action (`onecli_credential` rows are
 * swept-and-denied on boot, everything else is durable and keeps waiting).
 * `pending_channel_approvals` maps through a synthesized view
 * (channel-approval.ts) — the channel flow keeps its own table.
 *
 * Two eligibility kinds:
 *   - `exclusive` — only the named user may resolve (an a2a message policy's
 *     approver). Nobody else, including owners.
 *   - `admins-of-scope` — the admin chain of the anchoring agent group
 *     (scoped admin / global admin / owner), or owners + global admins when
 *     the anchor is null. When the hold records the user the card was
 *     delivered to, that user may also resolve — the sender/channel
 *     "named-or-admin" semantic, preserved verbatim from the pre-fold tables.
 *
 * The approver-scope overlay is the D1 fix: a hold whose action has global
 * blast radius (e.g. `roles grant`) can only be resolved by an owner or
 * global admin — a scoped admin's click is rejected regardless of the
 * eligibility rule.
 *
 * `mayResolve` replaces the three divergent click-auth copies (approvals
 * response handler, sender handler, channel handler) with one function.
 */
import type { ApproverEligibility, ApproverScope, PendingApproval } from '../../types.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';

export type { ApproverEligibility, ApproverScope } from '../../types.js';

/** May `clickerUserId` (namespaced `<channel>:<handle>`) resolve a hold with this eligibility + scope? */
export function mayResolve(e: ApproverEligibility, scope: ApproverScope, clickerUserId: string | null): boolean {
  if (!clickerUserId) return false;

  const globalScopeOk = scope !== 'global' || isOwner(clickerUserId) || isGlobalAdmin(clickerUserId);

  if (e.kind === 'exclusive') {
    return clickerUserId === e.approverUserId && globalScopeOk;
  }

  const eligible =
    (e.deliveredTo !== null && clickerUserId === e.deliveredTo) ||
    (e.agentGroupId
      ? hasAdminPrivilege(clickerUserId, e.agentGroupId)
      : isOwner(clickerUserId) || isGlobalAdmin(clickerUserId));

  return eligible && globalScopeOk;
}

/** The eligibility rule a `pending_approvals` row encodes. */
export function eligibilityOf(
  approval: Pick<PendingApproval, 'eligibility' | 'approver_user_id' | 'agent_group_id'>,
): ApproverEligibility {
  if (approval.eligibility === 'exclusive' && approval.approver_user_id) {
    return { kind: 'exclusive', approverUserId: approval.approver_user_id };
  }
  return {
    kind: 'admins-of-scope',
    agentGroupId: approval.agent_group_id,
    deliveredTo: approval.eligibility === 'exclusive' ? null : approval.approver_user_id,
  };
}
