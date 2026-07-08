/**
 * Guard conformance — the non-bypass invariant, shared by CI and boot.
 *
 * CI only protects code that goes through the repo's CI, but NanoClaw's
 * extension model is skill-installed code: /add-* skills copy modules into
 * the user's tree and register handlers on machines where the test suite
 * never runs. Running the same walk at boot turns the conformance test's
 * guarantee into a runtime invariant at exactly that trust boundary: every
 * registration is an import-time side effect, so by the time main() runs
 * the registries are complete and an unmapped privileged entry is
 * detectable before the host accepts a single message.
 *
 * Fail-closed: the host refuses to start (the upgrade-tripwire posture).
 * A conformance failure is code mis-composition — fixable with the host
 * down — and it surfaces at skill-install time, when the installing agent
 * is watching, instead of running unguarded until someone runs pnpm test.
 *
 * Limit: the walk verifies DECLARED mappings ("every delivery action is
 * guarded or explicitly exempt") — it cannot infer which actions are
 * privileged. That declaration stays on the author; the exemption list
 * below is the loud, reviewable escape hatch.
 */
import { commandGuardAction } from './cli/guard.js';
import { listCommands } from './cli/registry.js';
import { listDeliveryActions } from './delivery.js';
import { getGuardedAction } from './guard/index.js';
import { log } from './log.js';

/**
 * Delivery actions that deliberately carry no guard mapping (the declared
 * exemption class, per the guarded-actions design decision 1):
 *   - scheduling self-actions — an agent mutating only its own task rows;
 *     not a privileged action class (yet).
 *   - cli_request — the transport bridge into dispatch(); every inner
 *     command is guarded at dispatch, so the envelope carries no privilege.
 */
export const EXEMPT_DELIVERY_ACTIONS = new Set([
  'schedule_task',
  'cancel_task',
  'pause_task',
  'resume_task',
  'update_task',
  'cli_request',
]);

/** Walk the live registries against the guard catalog. Empty = conformant. */
export function guardConformanceViolations(): string[] {
  const violations: string[] = [];

  for (const cmd of listCommands()) {
    const entry = getGuardedAction(commandGuardAction(cmd));
    if (!entry) {
      violations.push(`command "${cmd.name}" has no guard-catalog entry`);
      continue;
    }
    if (cmd.access === 'approval' && entry.approvalAction !== 'cli_command') {
      violations.push(`mutating command "${cmd.name}" maps to a catalog entry that cannot hold`);
    }
  }

  for (const { action, guardAction } of listDeliveryActions()) {
    if (guardAction === null) {
      if (!EXEMPT_DELIVERY_ACTIONS.has(action)) {
        violations.push(`delivery action "${action}" is neither guard-mapped nor on the declared exemption list`);
      }
      continue;
    }
    if (!getGuardedAction(guardAction)) {
      violations.push(`delivery action "${action}" maps to unregistered guard action "${guardAction}"`);
    }
  }

  return violations;
}

/**
 * Boot check: refuse to start when any privileged registration is unmapped.
 * Call after all import-time registrations (any point in main()).
 */
export function enforceGuardConformance(): void {
  const violations = guardConformanceViolations();
  if (violations.length === 0) return;

  console.error(
    [
      '',
      '='.repeat(64),
      'NanoClaw stopped: guard conformance failure',
      '='.repeat(64),
      'A privileged registration is not mapped to the guard catalog —',
      'it would run with no allow/hold/deny decision. This usually means',
      'a skill (or local change) registered a command or delivery action',
      'without a guard spec.',
      '',
      ...violations.map((v) => `  - ${v}`),
      '',
      'Fix the registration (pass a guard spec / derive a catalog entry),',
      'or — only for genuinely unprivileged self-actions — add it to',
      'EXEMPT_DELIVERY_ACTIONS in src/guard-conformance.ts.',
      '='.repeat(64),
      '',
    ].join('\n'),
  );
  log.error('Guard conformance failure — refusing to start', { violations });
  process.exit(1);
}
