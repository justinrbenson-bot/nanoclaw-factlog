/**
 * Guard conformance — the non-bypass invariant, checked structurally.
 *
 * Walks the real command registry and the real delivery-action registry
 * (loaded via their production barrels) and fails if any mutating entry
 * lacks a guard-catalog mapping. A new privileged command or delivery
 * action cannot quietly ship ungated: registration derives the catalog
 * entry, and this test makes drift loud.
 *
 * Declared exemption classes (the enforcement boundary, per the
 * guarded-actions design decision 1):
 *   - scheduling self-actions — an agent scheduling its own wake-ups mutates
 *     only its own task rows; not a privileged action class (yet).
 *   - cli_request — the transport bridge into dispatch(); every inner
 *     command is guarded at dispatch, so the envelope itself carries no
 *     privilege.
 *   - reads (list/get/help) are catalog-mapped via registration too, but
 *     their baselines allow; the mutating set is what MUST be mapped.
 */
import { describe, expect, it } from 'vitest';

// Production barrels — side-effect imports populate the real registries.
import '../cli/commands/index.js';
import '../modules/index.js';
import '../cli/delivery-action.js';

import { listCommands } from '../cli/registry.js';
import { commandGuardAction } from '../cli/guard.js';
import { listDeliveryActions } from '../delivery.js';
import { getGuardedAction } from './catalog.js';

const EXEMPT_DELIVERY_ACTIONS = new Set([
  // Scheduling self-actions: the agent mutating its own schedule.
  'schedule_task',
  'cancel_task',
  'pause_task',
  'resume_task',
  'update_task',
  // Transport bridge: inner commands are guarded at dispatch.
  'cli_request',
]);

describe('guard conformance', () => {
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
});
