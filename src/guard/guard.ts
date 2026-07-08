/**
 * guard() — the one decision function every privileged action consults.
 *
 * The decision is the catalog entry's structural baseline — today's code
 * checks, registered per action at the module edges. Non-catalog actions
 * (reads, scheduling self-actions) allow. Policy-as-data (tighten-only rule
 * sources composing with the baseline) is deliberately deferred to phase 3
 * of the guarded-actions design, where the generalized rules table arrives
 * with its first operator-visible consumer; until then the one policy table
 * (agent_message_policies) is consulted inside the a2a.send baseline.
 *
 * Grants: an approved replay carries the verified approval row. A valid
 * grant (live pending row whose action matches the catalog entry's approval
 * action, plus any domain binding) satisfies a hold — the human already
 * decided — but NEVER a deny: the baseline is re-checked live, so
 * approve-then-revoke no longer executes. A grant that is present but
 * invalid fails closed to deny (no second card).
 *
 * The guard itself fails closed: a throwing baseline denies.
 */
import { getPendingApproval } from '../db/sessions.js';
import { log } from '../log.js';
import { getGuardedAction } from './catalog.js';
import { ALLOW, DENY, type GuardDecision, type GuardInput } from './types.js';

export function guard(input: GuardInput): GuardDecision {
  const entry = getGuardedAction(input.action);

  let decision: GuardDecision;
  try {
    decision = entry ? entry.baseline(input) : ALLOW('non-catalog action');
  } catch (err) {
    log.error('Guard evaluation threw — failing closed', { action: input.action, err });
    return DENY('guard failure (failing closed)');
  }

  if (!input.grant || decision.effect !== 'hold') {
    // A grant never loosens a deny (the baseline re-check is live), and a
    // grant on an already-allowed action is a no-op.
    return decision;
  }

  // An invalid grant on a replay is a refusal, not a fresh hold — approved
  // replays must execute exactly once.
  if (entry && grantSatisfies(input, entry.approvalAction, entry.grantMatches)) {
    return ALLOW(`hold satisfied by approval ${input.grant.approval_id}`);
  }
  return DENY('replay carried an invalid or mismatched grant');
}

function grantSatisfies(
  input: GuardInput,
  approvalAction: string | undefined,
  grantMatches: ((grant: NonNullable<GuardInput['grant']>, input: GuardInput) => boolean) | undefined,
): boolean {
  const grant = input.grant;
  if (!grant || !approvalAction) return false;
  if (grant.action !== approvalAction) return false;
  // The row must still be live — resolution deletes it, so a grant can only
  // execute once and a fabricated row object doesn't pass.
  const live = getPendingApproval(grant.approval_id);
  if (!live || live.action !== approvalAction) return false;
  if (grantMatches && !grantMatches(grant, input)) return false;
  return true;
}
