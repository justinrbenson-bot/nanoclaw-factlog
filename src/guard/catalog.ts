/**
 * The action catalog — the enforcement boundary.
 *
 * An action either is in the catalog (and passes a decision) or is not (and
 * needs none — reads, scheduling self-actions). Declaration is registration:
 * entries are derived at the registries' registration sites (command
 * registry, delivery actions, response handlers, interceptors, module
 * edges), never maintained in a second file. The conformance test walks the
 * registries against this catalog so an unmapped privileged action fails CI.
 */
import { log } from '../log.js';
import type { GuardDecision, GuardInput } from './types.js';
import type { PendingApproval } from '../types.js';

export interface GuardedActionSpec {
  /** Dotted action name — the catalog key. */
  action: string;
  /**
   * Today's structural checks for this action, verbatim — the only source of
   * allow. Runs on every consult, including approved replays (a grant
   * satisfies a hold, never a deny).
   */
  baseline: (input: GuardInput) => GuardDecision;
  /**
   * The pending_approvals.action its holds resolve through — a grant is only
   * accepted when its row carries this action. Omit for actions that can
   * never be held (deny/allow-only baselines).
   */
  approvalAction?: string;
  /**
   * Extra domain binding between a grant and the replayed input (e.g. the
   * a2a target must match the held message). Runs in addition to the
   * approvalAction + live-row checks.
   */
  grantMatches?: (grant: PendingApproval, input: GuardInput) => boolean;
}

const catalog = new Map<string, GuardedActionSpec>();

export function registerGuardedAction(spec: GuardedActionSpec): void {
  if (catalog.has(spec.action)) {
    log.warn('Guarded action re-registered (overwriting)', { action: spec.action });
  }
  catalog.set(spec.action, spec);
}

export function getGuardedAction(action: string): GuardedActionSpec | undefined {
  return catalog.get(action);
}

export function listGuardedActions(): GuardedActionSpec[] {
  return [...catalog.values()].sort((a, b) => a.action.localeCompare(b.action));
}
