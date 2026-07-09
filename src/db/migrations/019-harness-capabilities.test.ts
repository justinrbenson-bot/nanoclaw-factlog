/**
 * Migration 019 is upgrade-safe: it grandfathers EXISTING groups to their
 * pre-feature behavior (agent-teams + Workflow on) so an upgrade changes
 * nothing, while groups created after it get the lean column default.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../agent-groups.js';
import { closeDb, getDb, initTestDb } from '../connection.js';
import { getContainerConfig } from '../container-configs.js';
import { migrations, runMigrations } from './index.js';

const now = () => new Date().toISOString();

function group(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

describe('migration 019 (harness-capabilities) upgrade safety', () => {
  beforeEach(() => {
    const db = initTestDb();
    // Run everything EXCEPT 019 to reach the pre-upgrade schema (no column yet).
    runMigrations(
      db,
      migrations.filter((m) => m.name !== 'harness-capabilities'),
    );
  });

  afterEach(() => closeDb());

  it('grandfathers a pre-existing group to teams+workflow on; leaves later rows lean', () => {
    const db = getDb();
    // A group that existed before the upgrade (raw insert — column absent yet).
    group('ag-old');
    db.prepare('INSERT INTO container_configs (agent_group_id, updated_at) VALUES (?, ?)').run('ag-old', now());

    // The upgrade: run migration 019.
    runMigrations(
      db,
      migrations.filter((m) => m.name === 'harness-capabilities'),
    );

    // Existing group keeps its prior behavior — non-breaking.
    expect(JSON.parse(getContainerConfig('ag-old')!.harness_capabilities)).toEqual({
      'agent-teams': 'on',
      workflow: 'on',
    });

    // A group created AFTER the migration gets the lean column default.
    group('ag-new');
    db.prepare('INSERT INTO container_configs (agent_group_id, updated_at) VALUES (?, ?)').run('ag-new', now());
    expect(JSON.parse(getContainerConfig('ag-new')!.harness_capabilities)).toEqual({});
  });

  it('is a no-op on a fresh install (no existing rows) — new groups start lean', () => {
    const db = getDb();
    runMigrations(
      db,
      migrations.filter((m) => m.name === 'harness-capabilities'),
    );
    group('ag-fresh');
    db.prepare('INSERT INTO container_configs (agent_group_id, updated_at) VALUES (?, ?)').run('ag-fresh', now());
    expect(JSON.parse(getContainerConfig('ag-fresh')!.harness_capabilities)).toEqual({});
  });
});
