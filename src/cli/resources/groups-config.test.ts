/**
 * ncl round-trip for the harness-capabilities config surface: set an
 * override, clear it with `default`, reject unknown keys/values, and render
 * both the raw overrides and the resolved (default)/(override) view in
 * `config get`. Host caller — the same code path an approved update takes.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-groups-config' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-groups-config';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands.
import './groups.js';

const GID = 'ag-caps';
const hostCtx = { caller: 'host' as const };

async function configUpdate(caps: string) {
  return dispatch(
    { id: 't', command: 'groups-config-update', args: { id: GID, 'harness-capabilities': caps } },
    hostCtx,
  );
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({
    id: GID,
    name: 'caps',
    folder: 'caps',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  ensureContainerConfig(GID);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('groups config update --harness-capabilities', () => {
  type Resolved = Record<string, { state: string; source: string }>;

  it('sets an override and marks it as an override in the resolved view', async () => {
    const resp = await configUpdate('agent-teams=on');

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as {
        harness_capabilities: Record<string, string>;
        harness_capabilities_resolved: Resolved;
      };
      expect(data.harness_capabilities).toEqual({ 'agent-teams': 'on' });
      expect(data.harness_capabilities_resolved['agent-teams']).toEqual({ state: 'on', source: 'override' });
      expect(data.harness_capabilities_resolved.workflow).toEqual({ state: 'off', source: 'default' });
    }
    expect(JSON.parse(getContainerConfig(GID)!.harness_capabilities)).toEqual({ 'agent-teams': 'on' });
  });

  it('`default` clears the override and the resolved view returns to default', async () => {
    await configUpdate('agent-teams=on');
    const resp = await configUpdate('agent-teams=default');

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { harness_capabilities_resolved: Resolved };
      expect(data.harness_capabilities_resolved['agent-teams']).toEqual({ state: 'off', source: 'default' });
    }
    expect(JSON.parse(getContainerConfig(GID)!.harness_capabilities)).toEqual({});
  });

  it('rejects unknown keys and bad values with usable messages', async () => {
    const unknown = await configUpdate('web=off');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.message).toContain('unknown harness capability');

    const badValue = await configUpdate('workflow=sideways');
    expect(badValue.ok).toBe(false);
    if (!badValue.ok) expect(badValue.error.message).toContain('on, off, or default');
  });

  it('a harness-only update passes the nothing-to-update guard', async () => {
    const resp = await configUpdate('workflow=on');
    expect(resp.ok).toBe(true);
  });

  it('config get shows raw overrides plus the resolved view', async () => {
    await configUpdate('workflow=on');
    const resp = await dispatch({ id: 't', command: 'groups-config-get', args: { id: GID } }, hostCtx);

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as {
        harness_capabilities: Record<string, string>;
        harness_capabilities_resolved: Resolved;
      };
      expect(data.harness_capabilities).toEqual({ workflow: 'on' });
      expect(data.harness_capabilities_resolved).toEqual({
        'agent-teams': { state: 'off', source: 'default' },
        workflow: { state: 'on', source: 'override' },
      });
    }
  });

  it('a stored invalid value reports source=default, not a lying override', async () => {
    // Direct DB write bypassing validation (version skew / manual edit).
    updateContainerConfigJson(GID, 'harness_capabilities', { workflow: 'sideways' });
    const resp = await dispatch({ id: 't', command: 'groups-config-get', args: { id: GID } }, hostCtx);

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { harness_capabilities_resolved: Resolved };
      expect(data.harness_capabilities_resolved.workflow).toEqual({ state: 'off', source: 'default' });
    }
  });
});
