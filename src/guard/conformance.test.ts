/**
 * Guard conformance — the non-bypass invariant, checked structurally.
 *
 * Walks the real command registry and the real delivery-action registry
 * (loaded via their production barrels) against the guard catalog. The walk
 * itself lives in src/guard-conformance.ts and runs twice: here in CI, and
 * at every boot (enforceGuardConformance in index.ts refuses to start on a
 * violation) — CI can't see skill-installed registrations, the boot check
 * can. A new privileged command or delivery action cannot quietly ship
 * ungated: registration derives the catalog entry, and this walk makes
 * drift loud.
 *
 * The declared exemption classes live with the walk
 * (EXEMPT_DELIVERY_ACTIONS): scheduling self-actions and the cli_request
 * transport bridge (its inner commands are guarded at dispatch). Reads
 * (list/get/help) are catalog-mapped via registration too, but their
 * baselines allow; the mutating set is what MUST be mapped.
 */
import { describe, expect, it } from 'vitest';

// Production barrels — side-effect imports populate the real registries.
import '../cli/commands/index.js';
import '../modules/index.js';
import '../cli/delivery-action.js';

import { listCommands } from '../cli/registry.js';
import { commandGuardAction } from '../cli/guard.js';
import { listDeliveryActions, registerDeliveryAction } from '../delivery.js';
import { EXEMPT_DELIVERY_ACTIONS, guardConformanceViolations } from '../guard-conformance.js';
import { getGuardedAction } from './catalog.js';

describe('guard conformance', () => {
  it('the full walk (shared with the boot check) reports zero violations', () => {
    expect(guardConformanceViolations()).toEqual([]);
  });

  it('every mutating ncl command maps to a guard catalog entry that can hold', () => {
    const mutating = listCommands().filter((cmd) => cmd.access === 'approval');
    expect(mutating.length).toBeGreaterThan(0);

    const unmapped = mutating.filter((cmd) => {
      const entry = getGuardedAction(commandGuardAction(cmd));
      return !entry || entry.approvalAction !== 'cli_command';
    });
    expect(unmapped.map((c) => c.name)).toEqual([]);
  });

  it('every registered command (reads included) has a catalog entry — denied reads still surface as denials', () => {
    const unmapped = listCommands().filter((cmd) => !getGuardedAction(commandGuardAction(cmd)));
    expect(unmapped.map((c) => c.name)).toEqual([]);
  });

  it('every delivery action is guard-mapped or on the declared exemption list', () => {
    const actions = listDeliveryActions();
    expect(actions.length).toBeGreaterThan(0);

    const unmapped = actions.filter(
      ({ action, guardAction }) => guardAction === null && !EXEMPT_DELIVERY_ACTIONS.has(action),
    );
    expect(unmapped.map((a) => a.action)).toEqual([]);

    const danglingCatalog = actions.filter(({ guardAction }) => guardAction !== null && !getGuardedAction(guardAction));
    expect(danglingCatalog.map((a) => a.action)).toEqual([]);
  });

  it('the privileged delivery actions are the guarded ones', () => {
    const guarded = Object.fromEntries(
      listDeliveryActions()
        .filter((a) => a.guardAction !== null)
        .map((a) => [a.action, a.guardAction]),
    );
    expect(guarded).toEqual({
      create_agent: 'agents.create',
      install_packages: 'self_mod.install_packages',
      add_mcp_server: 'self_mod.add_mcp_server',
    });
  });

  // KEEP LAST: registers a rogue action into the shared per-worker registry,
  // so every walk after this point sees the violation.
  it('the walk names an unguarded, non-exempt delivery action (what the boot check refuses on)', () => {
    registerDeliveryAction('test_rogue_privileged_action', async () => {});

    const violations = guardConformanceViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('test_rogue_privileged_action');
    expect(violations[0]).toContain('neither guard-mapped nor on the declared exemption list');
  });
});
