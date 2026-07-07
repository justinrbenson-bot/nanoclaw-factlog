/**
 * Rule sources — tighten-only policy data.
 *
 * A rule source maps a GuardInput to zero or more RuleDecisions (hold or
 * deny — data can never express allow; the structural baseline remains the
 * only source of allow). Sources are consulted on every guard() call and
 * composed with the baseline under the strictest-wins lattice, so a rule can
 * tighten a structural allow and nothing can loosen one.
 *
 * The first (and, until the guard_rules table lands, only) source is the a2a
 * agent_message_policies table, registered by the agent-to-agent module. A
 * throwing source fails the whole decision closed.
 */
import type { GuardInput, RuleDecision } from './types.js';

export type RuleSource = (input: GuardInput) => RuleDecision[];

const ruleSources: RuleSource[] = [];

export function registerRuleSource(source: RuleSource): void {
  ruleSources.push(source);
}

/** Every rule decision that bites this input. Throws propagate — guard() fails closed. */
export function collectRuleDecisions(input: GuardInput): RuleDecision[] {
  const decisions: RuleDecision[] = [];
  for (const source of ruleSources) {
    decisions.push(...source(input));
  }
  return decisions;
}
