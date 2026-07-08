/**
 * Materialization end-to-end: a stored harness_capabilities override reaches
 * groups/<folder>/container.json as the RESOLVED map (defaults ⊕ overrides),
 * which is the only shape the runner ever sees.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-container-config-test';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-container-config-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-container-config-test/groups',
}));

import { materializeContainerJson } from './container-config.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from './db/container-configs.js';

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('materializeContainerJson harness capabilities', () => {
  it('writes the resolved map — defaults for a fresh row, override applied when stored', () => {
    const ag = { id: 'ag-mat', name: 'mat', folder: 'mat', agent_provider: null, created_at: new Date().toISOString() };
    createAgentGroup(ag);
    ensureContainerConfig(ag.id);

    let config = materializeContainerJson(ag.id);
    expect(config.harnessCapabilities).toEqual({ 'agent-teams': 'off', workflow: 'off' });

    updateContainerConfigJson(ag.id, 'harness_capabilities', { workflow: 'on' });
    config = materializeContainerJson(ag.id);
    expect(config.harnessCapabilities).toEqual({ 'agent-teams': 'off', workflow: 'on' });

    const onDisk = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, 'groups', 'mat', 'container.json'), 'utf-8'));
    expect(onDisk.harnessCapabilities).toEqual({ 'agent-teams': 'off', workflow: 'on' });
  });
});
