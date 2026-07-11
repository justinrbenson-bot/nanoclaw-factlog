import fs from 'fs';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentGroup } from '../../types.js';

// Mutable config backing the config.js mock — tests flip transport/bin
// without re-importing the module under test. Hoisted above imports, so
// only plain path strings here; the dirs are created in beforeEach.
const state = vi.hoisted(() => {
  const tmp = (globalThis.process?.env?.TMPDIR ?? '/tmp').replace(/\/+$/, '');
  const base = `${tmp}/factlog-vitest-${globalThis.process?.pid}`;
  return {
    base,
    workspace: `${base}/ws`,
    groupsDir: `${base}/groups`,
    callsFile: `${base}/calls.log`,
    stubBin: `${base}/factlog-stub`,
    bin: `${base}/factlog-stub`,
    transport: 'socket',
    socket: `${base}/ws/.factlog/factlog.sock`,
    hostUrl: 'http://host.docker.internal:4711',
  };
});

vi.mock('../../config.js', () => ({
  get FACTLOG_WORKSPACE() {
    return state.workspace;
  },
  get FACTLOG_BIN() {
    return state.bin;
  },
  get FACTLOG_SOCKET() {
    return state.socket;
  },
  get FACTLOG_TRANSPORT() {
    return state.transport;
  },
  get FACTLOG_HOST_URL() {
    return state.hostUrl;
  },
  get GROUPS_DIR() {
    return state.groupsDir;
  },
}));

import {
  CONTAINER_SOCKET_PATH,
  factlogEnabled,
  loadFactlogGroupConfig,
  prepareFactlogRun,
  releaseFactlogRun,
  type FactlogRunIdentity,
} from './index.js';

const group = { id: 'ag-1', name: 'Meal Planner', folder: 'meal-planner' } as AgentGroup;

function makeSessionDir(): string {
  return fs.mkdtempSync(path.join(state.base, 'sess-'));
}

function readCalls(): string[] {
  try {
    return fs.readFileSync(state.callsFile, 'utf-8').trim().split('\n');
  } catch {
    return [];
  }
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  state.transport = 'socket';
  state.bin = state.stubBin;
  fs.mkdirSync(path.join(state.workspace, '.factlog'), { recursive: true });
  fs.mkdirSync(state.groupsDir, { recursive: true });
  fs.rmSync(state.callsFile, { force: true });
  fs.rmSync(path.join(state.groupsDir, group.folder), { recursive: true, force: true });
  fs.writeFileSync(
    state.stubBin,
    `#!/bin/bash\necho "$@" >> "${state.callsFile}"\nif [ "$1" = "token" ] && [ "$2" = "mint" ]; then echo "flt_stubtoken12345"; fi\n`,
    { mode: 0o755 },
  );
  // Socket transport requires the daemon socket inode to exist.
  fs.writeFileSync(state.socket, '');
});

afterAll(() => {
  fs.rmSync(state.base, { recursive: true, force: true });
});

describe('factlogEnabled', () => {
  it('requires an initialized workspace (.factlog present)', () => {
    expect(factlogEnabled()).toBe(true);
    fs.rmSync(path.join(state.workspace, '.factlog'), { recursive: true, force: true });
    expect(factlogEnabled()).toBe(false);
  });
});

describe('loadFactlogGroupConfig', () => {
  it('returns {} when the group has no factlog.json', () => {
    expect(loadFactlogGroupConfig(group.folder)).toEqual({});
  });

  it('reads groups/<folder>/factlog.json', () => {
    const dir = path.join(state.groupsDir, group.folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'factlog.json'), JSON.stringify({ homeScopes: ['topic://meals/**'] }));
    expect(loadFactlogGroupConfig(group.folder)).toEqual({ homeScopes: ['topic://meals/**'] });
  });
});

describe('prepareFactlogRun', () => {
  it('returns null (and writes nothing) when factlog is disabled', async () => {
    fs.rmSync(path.join(state.workspace, '.factlog'), { recursive: true, force: true });
    const sessDir = makeSessionDir();
    expect(await prepareFactlogRun(group, 'nc-run-1', sessDir)).toBeNull();
    expect(fs.existsSync(path.join(sessDir, 'factlog.json'))).toBe(false);
    expect(readCalls()).toEqual([]);
  });

  it('mints an external-origin token and writes the run identity (socket transport)', async () => {
    const sessDir = makeSessionDir();
    const run = await prepareFactlogRun(group, 'nc-run-2', sessDir);
    expect(run).not.toBeNull();
    expect(run!.mounts).toEqual([{ hostPath: state.socket, containerPath: CONTAINER_SOCKET_PATH, readonly: false }]);

    const identity = JSON.parse(fs.readFileSync(path.join(sessDir, 'factlog.json'), 'utf-8')) as FactlogRunIdentity;
    expect(identity).toEqual({
      transport: 'socket',
      socket: CONTAINER_SOCKET_PATH,
      token: 'flt_stubtoken12345',
      agent: 'meal-planner',
      session: 'nc-run-2',
    });

    const mint = readCalls().find((c) => c.startsWith('token mint'));
    expect(mint).toContain('--agent meal-planner');
    expect(mint).toContain('--session nc-run-2');
    // Taint at the source is the default: no config = external origin.
    expect(mint).toContain('--origin external');
  });

  it('passes group scopes to the mint and into the identity file', async () => {
    const dir = path.join(state.groupsDir, group.folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'factlog.json'),
      JSON.stringify({
        homeScopes: ['topic://meals/**', 'job://grocery-order'],
        writeScopes: ['topic://meals/**', 'job://**'],
      }),
    );
    const sessDir = makeSessionDir();
    const run = await prepareFactlogRun(group, 'nc-run-3', sessDir);
    expect(run).not.toBeNull();

    const identity = JSON.parse(fs.readFileSync(path.join(sessDir, 'factlog.json'), 'utf-8')) as FactlogRunIdentity;
    expect(identity.homeScopes).toEqual(['topic://meals/**', 'job://grocery-order']);
    expect(identity.writeScopes).toEqual(['topic://meals/**', 'job://**']);

    const mint = readCalls().find((c) => c.startsWith('token mint'));
    expect(mint).toContain('--write-scope topic://meals/** job://**');
  });

  it('omits --origin only on an explicit internal override', async () => {
    const dir = path.join(state.groupsDir, group.folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'factlog.json'), JSON.stringify({ origin: 'internal' }));
    await prepareFactlogRun(group, 'nc-run-4', makeSessionDir());
    const mint = readCalls().find((c) => c.startsWith('token mint'));
    expect(mint).toBeDefined();
    expect(mint).not.toContain('--origin');
  });

  it('uses the host-gateway URL (and no mounts) for http transport', async () => {
    state.transport = 'host-gateway';
    const sessDir = makeSessionDir();
    const run = await prepareFactlogRun(group, 'nc-run-5', sessDir);
    expect(run!.mounts).toEqual([]);
    const identity = JSON.parse(fs.readFileSync(path.join(sessDir, 'factlog.json'), 'utf-8')) as FactlogRunIdentity;
    expect(identity.transport).toBe('http');
    expect(identity.url).toBe('http://host.docker.internal:4711');
    expect(identity.socket).toBeUndefined();
  });

  it('returns null when the mint fails — the container spawns without factlog', async () => {
    state.bin = '/nonexistent/factlog-bin';
    const sessDir = makeSessionDir();
    expect(await prepareFactlogRun(group, 'nc-run-6', sessDir)).toBeNull();
    expect(fs.existsSync(path.join(sessDir, 'factlog.json'))).toBe(false);
  });

  it('returns null when socket transport is configured but the daemon socket is missing', async () => {
    fs.rmSync(state.socket, { force: true });
    expect(await prepareFactlogRun(group, 'nc-run-7', makeSessionDir())).toBeNull();
  });
});

describe('releaseFactlogRun', () => {
  it('revokes the run token, once', async () => {
    await prepareFactlogRun(group, 'nc-run-8', makeSessionDir());
    releaseFactlogRun('nc-run-8');
    await waitFor(() => readCalls().some((c) => c === 'token revoke flt_stubtoken12345'));
    expect(readCalls()).toContain('token revoke flt_stubtoken12345');

    fs.rmSync(state.callsFile, { force: true });
    releaseFactlogRun('nc-run-8'); // second release: token already dropped
    await new Promise((r) => setTimeout(r, 100));
    expect(readCalls()).toEqual([]);
  });

  it('is a no-op for unknown containers', () => {
    expect(() => releaseFactlogRun('never-prepared')).not.toThrow();
  });
});
