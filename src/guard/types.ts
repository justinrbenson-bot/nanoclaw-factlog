/**
 * Guard vocabulary — the decision seam every privileged action passes.
 *
 * The guard is a domain-free leaf: this module may import the DB read layer,
 * config, log, and shared types — never src/cli/* or src/modules/*. Domain
 * knowledge (what an action's structural baseline checks) arrives via
 * registration: catalog entries (catalog.ts) are registered by the domain
 * modules at their module edges.
 */
import type { ApproverRule, ApproverScope, PendingApproval } from '../types.js';

/** Who is attempting the action. Mirrors the CLI CallerContext + click identities. */
export type GuardActor =
  | { kind: 'host' }
  | { kind: 'agent'; agentGroupId: string; sessionId?: string }
  | { kind: 'human'; userId: string }
  | { kind: 'system' };

export interface GuardInput {
  /** Dotted catalog action name, e.g. 'roles.grant', 'agents.create', 'a2a.send'. */
  action: string;
  actor: GuardActor;
  /** Domain resource reference, e.g. { from, to } for a2a.send. */
  resource?: Record<string, string>;
  /** Action arguments — what the card summarizes and rules may later match on. */
  payload: Record<string, unknown>;
  /**
   * Verified approval row carried by an approved replay. A valid grant
   * satisfies a hold (the human already decided) but never a deny — the
   * structural baseline is re-checked live on every replay.
   */
  grant?: PendingApproval | null;
}

export type GuardDecision =
  | { effect: 'allow'; reason: string }
  | { effect: 'hold'; approverRule: ApproverRule; approverScope: ApproverScope; reason: string }
  | { effect: 'deny'; reason: string };

export const ALLOW = (reason: string): GuardDecision => ({ effect: 'allow', reason });
export const DENY = (reason: string): GuardDecision => ({ effect: 'deny', reason });
export const HOLD = (approverRule: ApproverRule, approverScope: ApproverScope, reason: string): GuardDecision => ({
  effect: 'hold',
  approverRule,
  approverScope,
  reason,
});
