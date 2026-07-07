/**
 * guard() — the one decision function every privileged action consults.
 *
 * Evaluation composes, never short-circuits: every rule-source decision AND
 * the structural baseline are evaluated, and the strictest effect wins
 * (deny > hold > allow). Rules are tighten-only, so a rule can turn a
 * structural allow into a hold or deny; nothing in data can loosen the
 * baseline. Non-catalog actions (reads, scheduling self-actions) allow.
 *
 * Holds compose by intersecting approver eligibility (decision 4 of the
 * guarded-actions design): two identical rules keep their rule; two
 * different admin scopes intersect to the global chain (owners + global
 * admins belong to every scope's chain); two different exclusive approvers
 * have an empty intersection — that conflict escalates to the global chain
 * and is logged loudly. Approver scope composes as max (global > group).
 *
 * Grants: an approved replay carries the verified approval row. A valid
 * grant (live pending row whose action matches the catalog entry's approval
 * action, plus any domain binding) satisfies a hold — the human already
 * decided — but NEVER a deny: the baseline is re-checked live, so
 * approve-then-revoke no longer executes. A grant that is present but
 * invalid fails closed to deny (no second card).
 *
 * The guard itself fails closed: a throwing rule source or baseline denies.
 */
import { getPendingApproval } from '../db/sessions.js';
import { log } from '../log.js';
import type { ApproverEligibility, ApproverScope } from '../types.js';
import { getGuardedAction } from './catalog.js';
import { collectRuleDecisions } from './rules.js';
import { ALLOW, DENY, type GuardDecision, type GuardInput, type RuleDecision } from './types.js';

export function guard(input: GuardInput): GuardDecision {
  let decision: GuardDecision;
  try {
    decision = evaluate(input);
  } catch (err) {
    log.error('Guard evaluation threw — failing closed', { action: input.action, err });
    return DENY('guard failure (failing closed)');
  }

  if (!input.grant) return decision;

  // A grant never loosens a deny, and an invalid grant on a replay is a
  // refusal, not a fresh hold — approved replays must execute exactly once.
  if (decision.effect === 'deny') return decision;
  if (decision.effect === 'allow') return decision;

  const entry = getGuardedAction(input.action);
  if (entry && grantSatisfies(input, entry.approvalAction, entry.grantMatches)) {
    return ALLOW(`hold satisfied by approval ${input.grant.approval_id}`);
  }
  return DENY('replay carried an invalid or mismatched grant');
}

function evaluate(input: GuardInput): GuardDecision {
  const ruleDecisions = collectRuleDecisions(input);
  const entry = getGuardedAction(input.action);
  const baseline = entry ? entry.baseline(input) : ALLOW('non-catalog action');
  return compose(ruleDecisions, baseline, input.action);
}

function compose(rules: RuleDecision[], baseline: GuardDecision, action: string): GuardDecision {
  const denies = [...rules.filter((r) => r.effect === 'deny'), ...(baseline.effect === 'deny' ? [baseline] : [])];
  if (denies.length > 0) {
    return DENY(denies.map((d) => d.reason).join('; '));
  }

  const holds = [
    ...rules.filter((r): r is Extract<RuleDecision, { effect: 'hold' }> => r.effect === 'hold'),
    ...(baseline.effect === 'hold' ? [baseline] : []),
  ];
  if (holds.length === 0) return baseline;

  let eligibility = holds[0].eligibility;
  for (const hold of holds.slice(1)) {
    const next = intersectEligibility(eligibility, hold.eligibility);
    if (next === 'empty') {
      log.warn('Hold composition produced an empty approver intersection — escalating to owners', {
        action,
        reasons: holds.map((h) => h.reason),
      });
      eligibility = { kind: 'admins-of-scope', agentGroupId: null, deliveredTo: null };
    } else {
      eligibility = next;
    }
  }

  const approverScope: ApproverScope = holds.some(
    (h) => ('approverScope' in h ? h.approverScope : 'group') === 'global',
  )
    ? 'global'
    : 'group';

  return {
    effect: 'hold',
    eligibility,
    approverScope,
    reason: holds.map((h) => h.reason).join('; '),
  };
}

/**
 * Intersect two eligibility rules. Every admins-of-scope set contains the
 * owners and global admins, so two different scopes intersect to the global
 * chain (agentGroupId null). Two different exclusive approvers share nobody —
 * the caller escalates that conflict. An exclusive rule intersected with an
 * admin scope keeps the named approver (the stricter, more specific rule);
 * full set semantics arrive with org rules, which is when this pairing first
 * becomes reachable.
 */
function intersectEligibility(a: ApproverEligibility, b: ApproverEligibility): ApproverEligibility | 'empty' {
  if (a.kind === 'exclusive' && b.kind === 'exclusive') {
    return a.approverUserId === b.approverUserId ? a : 'empty';
  }
  if (a.kind === 'exclusive') return a;
  if (b.kind === 'exclusive') return b;
  if (a.agentGroupId === b.agentGroupId) {
    // Same scope: keep it; the delivered-to shortcut survives only when both
    // rules delivered to the same user.
    return {
      kind: 'admins-of-scope',
      agentGroupId: a.agentGroupId,
      deliveredTo: a.deliveredTo === b.deliveredTo ? a.deliveredTo : null,
    };
  }
  return { kind: 'admins-of-scope', agentGroupId: null, deliveredTo: null };
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
