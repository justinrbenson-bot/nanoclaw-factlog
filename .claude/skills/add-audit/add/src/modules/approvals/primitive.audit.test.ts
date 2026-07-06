/**
 * Pending-event coverage for the decorated requestApproval: the audit
 * decorator emits exactly one `pending` event per successfully queued hold,
 * naming the approval and the picked approver — and nothing when no hold
 * reached an approver.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appended = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-primitive-audit', AUDIT_ENABLED: true };
});

const TEST_DIR = '/tmp/nanoclaw-test-primitive-audit';

vi.mock('../../audit/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../audit/store.js')>();
  return {
    ...actual,
    appendAuditLine: (line: string) => {
      appended.lines.push(line);
    },
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

// No adapter: card delivery is skipped, the hold still succeeds.
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => null,
}));

// Resolve any approver to a reachable fake DM without the platform stack.
vi.mock('../permissions/user-dm.js', () => ({
  ensureUserDm: vi.fn(async () => ({
    id: 'mg-dm',
    channel_type: 'telegram',
    platform_id: 'dm-owner',
  })),
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, getPendingApproval } from '../../db/sessions.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { requestApproval } from './primitive.js';
import type { Session } from '../../types.js';

function now(): string {
  return new Date().toISOString();
}

let session: Session;

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  appended.lines.length = 0;
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  createSession(session);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function grantOwner(): void {
  upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
}

function events(): Array<Record<string, any>> {
  return appended.lines.map((l) => JSON.parse(l));
}

describe('decorated requestApproval', () => {
  it('emits one pending event naming the approval and the picked approver', async () => {
    grantOwner();
    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'install_packages',
      payload: { apt: ['jq'], npm: [], reason: 'need jq' },
      title: 'Install Packages Request',
      question: 'ok?',
    });

    expect(appended.lines).toHaveLength(1);
    const [event] = events();
    expect(event).toMatchObject({
      actor: { type: 'agent', id: 'ag-1' },
      origin: { transport: 'container', session_id: 'sess-1' },
      action: 'self-mod.install-packages',
      outcome: 'pending',
      details: { apt: ['jq'], npm: [], reason: 'need jq' },
    });

    const approvalRef = event.resources.find((r: { type: string }) => r.type === 'approval');
    expect(approvalRef.id).toMatch(/^appr-/);
    expect(event.correlation_id).toBe(approvalRef.id);
    expect(event.resources).toContainEqual({ type: 'agent_group', id: 'ag-1' });
    expect(event.resources).toContainEqual({ type: 'user', id: 'telegram:owner' });
    // The event references the row that was actually created.
    expect(getPendingApproval(approvalRef.id)).toBeDefined();
  });

  it('emits nothing when no approver is configured (no hold was created)', async () => {
    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'install_packages',
      payload: { apt: ['jq'], npm: [] },
      title: 'Install Packages Request',
      question: 'ok?',
    });

    expect(appended.lines).toHaveLength(0);
  });

  it('records shape only for the message-bearing a2a gate — never the body', async () => {
    grantOwner();
    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'a2a_message_gate',
      approverUserId: 'telegram:owner',
      payload: {
        id: 'msg-1',
        platform_id: 'ag-target',
        content: JSON.stringify({ text: 'hello world', files: ['report.pdf'] }),
        in_reply_to: null,
      },
      title: 'Message approval',
      question: 'ok?',
    });

    const [event] = events();
    expect(event.action).toBe('messages.a2a-gate');
    expect(event.details).toEqual({ to: 'ag-target', body_chars: 11, attachments: ['report.pdf'] });
    expect(JSON.stringify(event)).not.toContain('hello world');
    expect(event.resources).toContainEqual({ type: 'agent_group', id: 'ag-target' });
  });
});
