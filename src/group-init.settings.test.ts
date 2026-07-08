import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-group-init-settings-test';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-group-init-settings-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-group-init-settings-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import type { HarnessCapabilityState } from './harness-capabilities.js';
import type { AgentGroup } from './types.js';

const TEAMS_ENV_KEY = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';
const DEFAULT_CAPS: Record<string, HarnessCapabilityState> = { 'agent-teams': 'off', workflow: 'off' };

let seq = 0;
function makeGroup(): AgentGroup {
  seq += 1;
  const ag = {
    id: `ag-settings-${seq}`,
    name: `settings-${seq}`,
    folder: `settings-${seq}`,
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as AgentGroup;
  createAgentGroup(ag);
  return ag;
}

function settingsPath(ag: AgentGroup): string {
  return path.join(TEST_ROOT, 'data', 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
}

function readSettings(ag: AgentGroup): Record<string, unknown> & { env?: Record<string, string> } {
  return JSON.parse(fs.readFileSync(settingsPath(ag), 'utf-8'));
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('reconcileHarnessSettings via initGroupFilesystem', () => {
  it('first spawn with defaults: no teams key, disableWorkflows set, unmanaged keys intact', () => {
    const ag = makeGroup();
    initGroupFilesystem(ag, { harnessCapabilities: DEFAULT_CAPS });

    const s = readSettings(ag);
    expect(s.env?.[TEAMS_ENV_KEY]).toBeUndefined();
    expect(s.disableWorkflows).toBe(true);
    expect(s.env?.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    expect(s.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
    expect(JSON.stringify(s.hooks)).toContain('compact-instructions');
  });

  it('agent-teams=on adds the env key; workflow=on removes disableWorkflows', () => {
    const ag = makeGroup();
    initGroupFilesystem(ag, { harnessCapabilities: { 'agent-teams': 'on', workflow: 'on' } });

    const s = readSettings(ag);
    expect(s.env?.[TEAMS_ENV_KEY]).toBe('1');
    expect('disableWorkflows' in s).toBe(false);
  });

  it('converges a legacy settings.json: strips the always-on teams key, preserves hand additions', () => {
    const ag = makeGroup();
    const file = settingsPath(ag);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          env: { [TEAMS_ENV_KEY]: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', OPERATOR_CUSTOM: 'keep-me' },
          hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'bun /app/src/compact-instructions.ts' }] }] },
          operatorCustomTopLevel: { nested: true },
        },
        null,
        2,
      ) + '\n',
    );

    initGroupFilesystem(ag, { harnessCapabilities: DEFAULT_CAPS });

    const s = readSettings(ag);
    expect(s.env?.[TEAMS_ENV_KEY]).toBeUndefined();
    expect(s.env?.OPERATOR_CUSTOM).toBe('keep-me');
    expect(s.operatorCustomTopLevel).toEqual({ nested: true });
    expect(s.disableWorkflows).toBe(true);
  });

  it('is write-stable: same caps on a second run leave the file byte-identical and unwritten', () => {
    const ag = makeGroup();
    initGroupFilesystem(ag, { harnessCapabilities: DEFAULT_CAPS });
    const file = settingsPath(ag);
    const before = fs.readFileSync(file, 'utf-8');
    const mtimeBefore = fs.statSync(file).mtimeMs;

    initGroupFilesystem(ag, { harnessCapabilities: DEFAULT_CAPS });

    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeBefore);
  });

  it('leaves the file alone and warns instead of throwing on malformed JSON', () => {
    const ag = makeGroup();
    const file = settingsPath(ag);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');

    expect(() => initGroupFilesystem(ag, { harnessCapabilities: DEFAULT_CAPS })).not.toThrow();
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ not json');
    expect(vi.mocked(log.warn).mock.calls.some(([msg]) => String(msg).includes('malformed'))).toBe(true);
  });

  it('does not touch settings.json when no capabilities are passed (non-spawn callers)', () => {
    const ag = makeGroup();
    initGroupFilesystem(ag, { harnessCapabilities: DEFAULT_CAPS });
    const file = settingsPath(ag);
    const withCaps = fs.readFileSync(file, 'utf-8');

    // Simulate a non-spawn caller (create-agent, channel-approval): no opt.
    initGroupFilesystem(ag);

    expect(fs.readFileSync(file, 'utf-8')).toBe(withCaps);
  });
});
