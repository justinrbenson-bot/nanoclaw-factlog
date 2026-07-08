/**
 * Audit middleware behavior of the exported dispatch — what gets recorded,
 * for whom, and how gated chains correlate. Drives the real wrapped dispatch
 * (real registry, real guard); audit is force-enabled and the store's append
 * is captured. DB reads and approval delivery are mocked.
 */
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingApproval } from '../types.js';

const appended = vi.hoisted(() => ({ lines: [] as string[] }));
const pendingRows = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('../audit/config.js', () => ({
  AUDIT_ENABLED: true,
  AUDIT_RETENTION_DAYS: 90,
}));

// Neutralize the adapter's module-scope boot (writability assert, prune,
// maintenance timer) — the middleware is the unit under test here.
vi.mock('../audit/init.js', () => ({
  initAuditLog: vi.fn(),
  maintainAudit: vi.fn(),
}));

vi.mock('../audit/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audit/store.js')>();
  return {
    ...actual,
    appendAuditLine: (line: string) => {
      appended.lines.push(line);
    },
  };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const mockGetContainerConfig = vi.fn();
vi.mock('../db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(...args),
}));

vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(() => ({ id: 'g1', name: 'Group One' })),
}));

const mockGetPendingApproval = vi.fn();
vi.mock('../db/sessions.js', () => ({
  getSession: vi.fn(() => ({ id: 's1', agent_group_id: 'g1', messaging_group_id: 'mg1' })),
  getPendingApproval: (...args: unknown[]) => mockGetPendingApproval(...args),
  getPendingApprovalsByAction: () => pendingRows.rows,
}));

vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn(() => ({ channel_type: 'slack' })),
}));

const mockGetResource = vi.fn();
vi.mock('./crud.js', () => ({
  getResource: (...args: unknown[]) => mockGetResource(...args),
}));

vi.mock('../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: vi.fn(async () => undefined),
}));

import { register } from './registry.js';

register({
  name: 'groups-test',
  description: 'echo command on the groups resource',
  action: 'groups.test',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'groups-get',
  description: 'echo command for dash-joined id resolution',
  action: 'groups.get',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'wirings-list',
  description: 'not on the group-scope allowlist',
  action: 'wirings.list',
  resource: 'wirings',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async () => [],
});

register({
  name: 'groups-fail',
  description: 'handler that throws',
  action: 'groups.fail',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async () => {
    throw new Error('boom');
  },
});

register({
  name: 'groups-gated',
  description: 'approval-gated command',
  action: 'groups.gated',
  resource: 'groups',
  access: 'approval',
  parseArgs: (raw) => raw,
  handler: async () => 'ran',
});

import { dispatch } from './dispatch.js';
import type { CallerContext } from './frame.js';

const AGENT_CTX: CallerContext = { caller: 'agent', sessionId: 's1', agentGroupId: 'g1', messagingGroupId: 'mg1' };

function grantRow(frameId: string, command: string): PendingApproval {
  return {
    approval_id: 'appr-123-abc',
    session_id: 's1',
    request_id: 'appr-123-abc',
    action: 'cli_command',
    payload: JSON.stringify({ frame: { id: frameId, command, args: {} }, callerContext: AGENT_CTX }),
    created_at: new Date().toISOString(),
    agent_group_id: 'g1',
    channel_type: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: 'CLI: groups-gated',
    options_json: '[]',
    approver_user_id: null,
  };
}

function events(): Array<Record<string, any>> {
  return appended.lines.map((l) => JSON.parse(l));
}

beforeEach(() => {
  vi.clearAllMocks();
  appended.lines.length = 0;
  pendingRows.rows = [];
  mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
  mockGetResource.mockImplementation((plural: string) => (plural === 'groups' ? { scopeField: 'id' } : undefined));
});

describe('withAudit(dispatch)', () => {
  it('records a success event for a host caller with socket origin and host actor', async () => {
    const resp = await dispatch({ id: '1', command: 'groups-test', args: { foo: 'bar' } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const [event] = events();
    expect(event).toMatchObject({
      schema_version: 1,
      actor: { type: 'human', id: `host:${os.userInfo().username}`, email: null },
      origin: { transport: 'socket' },
      action: 'groups.test',
      outcome: 'success',
      correlation_id: null,
      details: { foo: 'bar' },
    });
  });

  it('records effective args after group auto-fill, with container origin and channel', async () => {
    await dispatch({ id: '1', command: 'groups-test', args: {} }, AGENT_CTX);

    const [event] = events();
    expect(event.actor).toMatchObject({ type: 'agent', id: 'g1' });
    expect(event.origin).toEqual({
      transport: 'container',
      session_id: 's1',
      messaging_group_id: 'mg1',
      channel: 'slack',
    });
    expect(event.details).toMatchObject({ id: 'g1', agent_group_id: 'g1', group: 'g1' });
    expect(event.resources).toContainEqual({ type: 'agent_group', id: 'g1' });
  });

  it('records a denied event for a scope denial, naming the attempted resource type', async () => {
    const resp = await dispatch({ id: '1', command: 'wirings-list', args: {} }, AGENT_CTX);

    expect(resp.ok).toBe(false);
    const [event] = events();
    expect(event).toMatchObject({
      action: 'wirings.list',
      outcome: 'denied',
      resources: [{ type: 'wirings' }],
      details: { error: 'forbidden' },
    });
    expect(event.details.reason).toContain('scoped');
  });

  it('records a failure event when the handler throws', async () => {
    await dispatch({ id: '1', command: 'groups-fail', args: {} }, { caller: 'host' });

    const [event] = events();
    expect(event).toMatchObject({ action: 'groups.fail', outcome: 'failure', details: { error: 'handler-error' } });
    expect(event.details.reason).toContain('boom');
  });

  it('records a hold as a pending event correlated to the approval row it created', async () => {
    pendingRows.rows = [grantRow('1', 'groups-gated')];

    const resp = await dispatch({ id: '1', command: 'groups-gated', args: {} }, AGENT_CTX);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
    const [event] = events();
    expect(event).toMatchObject({
      action: 'groups.gated',
      outcome: 'pending',
      correlation_id: 'appr-123-abc',
    });
    expect(event.resources).toContainEqual({ type: 'approval', id: 'appr-123-abc' });
    expect(event.details.error).toBeUndefined();
  });

  it('records an uncorrelated pending event when no approval row was created (no approver)', async () => {
    pendingRows.rows = [];

    await dispatch({ id: '1', command: 'groups-gated', args: {} }, AGENT_CTX);

    const [event] = events();
    expect(event).toMatchObject({ outcome: 'pending', correlation_id: null });
  });

  it('records an approved replay as success with the grant approval id as correlation_id', async () => {
    const grant = grantRow('9', 'groups-gated');
    mockGetPendingApproval.mockReturnValue(grant);

    const resp = await dispatch({ id: '9', command: 'groups-gated', args: {} }, AGENT_CTX, { grant });

    expect(resp.ok).toBe(true);
    const [event] = events();
    expect(event).toMatchObject({
      action: 'groups.gated',
      outcome: 'success',
      correlation_id: 'appr-123-abc',
    });
    expect(event.resources).toContainEqual({ type: 'approval', id: 'appr-123-abc' });
  });

  it('records unknown commands as cli.unknown-command with the raw name in details', async () => {
    await dispatch({ id: '1', command: 'nope-nothing', args: {} }, { caller: 'host' });

    const [event] = events();
    expect(event).toMatchObject({
      action: 'cli.unknown-command',
      outcome: 'failure',
      resources: [],
      details: { command: 'nope-nothing', error: 'unknown-command' },
    });
  });

  it('records the resolved command and id for dash-joined positional ids', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    await dispatch({ id: '1', command: `groups-get-${uuid}`, args: {} }, { caller: 'host' });

    const [event] = events();
    expect(event).toMatchObject({ action: 'groups.get', outcome: 'success' });
    expect(event.resources).toContainEqual({ type: 'agent_group', id: uuid });
    expect(event.details.id).toBe(uuid);
  });

  it('normalizes hyphenated arg keys in details', async () => {
    await dispatch({ id: '1', command: 'groups-test', args: { 'dry-run': 'true' } }, { caller: 'host' });

    const [event] = events();
    expect(event.details).toMatchObject({ dry_run: 'true' });
  });

  it('parses JSON string args so the redactor reaches their inner keys', async () => {
    await dispatch(
      { id: '1', command: 'groups-test', args: { env: '{"NOTION_TOKEN":"tok-123","SAFE":"ok"}', note: '{not json' } },
      { caller: 'host' },
    );

    const [event] = events();
    expect(event.details.env).toEqual({ NOTION_TOKEN: '[REDACTED]', SAFE: 'ok' });
    expect(event.details.note).toBe('{not json');
  });
});
