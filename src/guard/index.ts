/**
 * Guard — the privileged-action decision seam (guarded-actions phase 2).
 *
 * See the guarded-actions decisions doc on the team hub. One decision
 * function (guard.ts), a registration-derived action catalog (catalog.ts),
 * and tighten-only rule sources (rules.ts). Domain-free leaf: domain
 * baselines and rules register from the domain modules' edges.
 */
export { guard } from './guard.js';
export { registerGuardedAction, getGuardedAction, listGuardedActions, type GuardedActionSpec } from './catalog.js';
export { registerRuleSource, type RuleSource } from './rules.js';
export { ALLOW, DENY, HOLD, type GuardActor, type GuardDecision, type GuardInput, type RuleDecision } from './types.js';
