/**
 * Regression test — `ncl wirings create` must delegate to
 * `createMessagingGroupAgent` so the matching `agent_destinations` ACL row is
 * auto-created. The generic single-table INSERT skipped it, leaving ncl-wired
 * agents silently without the send authorization skill-wired agents get
 * (delivery throws "unauthorized channel destination" for non-origin sends).
 *
 * The approval handler in `dispatch.ts` re-enters `dispatch()` with
 * `caller: 'host'` after admin approval, so the test invokes dispatch with the
 * host caller — same code path a real approval would take.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-wirings' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-wirings';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `wirings-*` commands (including create).
import './wirings.js';

function now(): string {
  return new Date().toISOString();
}

describe('wirings CLI create auto-creates the send-authorization ACL row', () => {
  const GID = 'ag-1';
  const MGID = 'mg-1';

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: GID, name: 'agent', folder: 'agent', agent_provider: null, created_at: now() });
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'telegram', 'tg-1', 'telegram', 'chat', 1, 'strict', ?)`,
    ).run(MGID, now());
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('creates the wiring and the matching agent_destinations row', async () => {
    // Precondition: no destination exists yet.
    const before = getDb()
      .prepare('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?')
      .get(GID) as { c: number };
    expect(before.c).toBe(0);

    const resp = await dispatch(
      {
        id: 'req-create',
        command: 'wirings-create',
        args: { messaging_group_id: MGID, agent_group_id: GID },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);

    // The wiring row exists.
    const wiring = getDb()
      .prepare('SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
      .get(MGID, GID) as Record<string, unknown> | undefined;
    expect(wiring).toBeDefined();

    // The send-authorization ACL row was auto-created and points at the chat.
    const dest = getDb()
      .prepare('SELECT * FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ?')
      .get(GID, 'channel', MGID) as Record<string, unknown> | undefined;
    expect(dest).toBeDefined();
  });
});
