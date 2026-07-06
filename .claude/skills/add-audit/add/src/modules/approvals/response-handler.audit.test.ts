/**
 * Decision + terminal audit events across the approval resolution paths:
 * approvals.decide from the resolved observer, the terminal event from the
 * wrapped handler run (skipped for cli_command), and the system actor for
 * sweep-finalized rejects.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appended = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-response-handler-audit', AUDIT_ENABLED: true };
});

const TEST_DIR = '/tmp/nanoclaw-test-response-handler-audit';

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

// Self-registers the approvals.decide observer on import (the composed wiring).
import './approvals-observer.audit.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createPendingApproval, createSession, getPendingApproval, getSession } from '../../db/sessions.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { finalizeReject } from './finalize.js';
import { registerApprovalHandler } from './primitive.js';
import { handleApprovalsResponse } from './response-handler.js';


function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  appended.lines.length = 0;
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function seedApproval(id: string, action: string, payload: Record<string, unknown>): void {
  createPendingApproval({
    approval_id: id,
    session_id: 'sess-1',
    request_id: id,
    action,
    payload: JSON.stringify(payload),
    created_at: now(),
    title: 'Test approval',
    options_json: JSON.stringify([]),
  });
}

function click(questionId: string, value: string) {
  return handleApprovalsResponse({
    questionId,
    value,
    userId: 'owner',
    channelType: 'telegram',
    platformId: 'dm-owner',
    threadId: null,
  });
}

function events(): Array<Record<string, any>> {
  return appended.lines.map((l) => JSON.parse(l));
}

describe('approval resolution audit events', () => {
  it('approve → terminal success (correlated) + approvals.decide with the human approver', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('install_packages', handler);
    seedApproval('appr-ok', 'install_packages', { apt: ['jq'], npm: [] });

    await click('appr-ok', 'approve');

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'appr-ok' }));

    const all = events();
    expect(all).toHaveLength(2);
    const [terminal, decide] = all;
    expect(terminal).toMatchObject({
      actor: { type: 'agent', id: 'ag-1' },
      action: 'self-mod.install-packages',
      outcome: 'success',
      correlation_id: 'appr-ok',
    });
    expect(terminal.resources).toContainEqual({ type: 'approval', id: 'appr-ok' });
    expect(decide).toMatchObject({
      actor: { type: 'human', id: 'telegram:owner' },
      origin: { transport: 'channel', channel: 'telegram' },
      action: 'approvals.decide',
      outcome: 'approved',
      correlation_id: 'appr-ok',
      details: { gated_action: 'self-mod.install-packages', requested_by: 'ag-1' },
    });
  });

  it('handler failure → terminal failure with the error, decision still recorded', async () => {
    registerApprovalHandler('add_mcp_server', async () => {
      throw new Error('rebuild exploded');
    });
    seedApproval('appr-fail', 'add_mcp_server', { name: 'notion', command: 'npx' });

    await click('appr-fail', 'approve');

    const all = events();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      action: 'self-mod.add-mcp-server',
      outcome: 'failure',
      correlation_id: 'appr-fail',
    });
    expect(all[0].details.error).toContain('rebuild exploded');
    expect(all[1]).toMatchObject({ action: 'approvals.decide', outcome: 'approved' });
  });

  it('cli_command approve → decide only; the terminal event belongs to the dispatch middleware', async () => {
    registerApprovalHandler('cli_command', vi.fn().mockResolvedValue(undefined));
    seedApproval('appr-cli', 'cli_command', {
      frame: { id: '1', command: 'groups-update', args: { id: 'ag-1' } },
      callerContext: { caller: 'agent', sessionId: 'sess-1', agentGroupId: 'ag-1', messagingGroupId: 'mg-1' },
    });

    await click('appr-cli', 'approve');

    const all = events();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ action: 'approvals.decide', outcome: 'approved', correlation_id: 'appr-cli' });
  });

  it('reject click → approvals.decide rejected, no terminal event', async () => {
    registerApprovalHandler('install_packages', vi.fn());
    seedApproval('appr-rej', 'install_packages', { apt: ['jq'], npm: [] });

    await click('appr-rej', 'reject');

    const all = events();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      actor: { type: 'human', id: 'telegram:owner' },
      action: 'approvals.decide',
      outcome: 'rejected',
      correlation_id: 'appr-rej',
    });
    expect(getPendingApproval('appr-rej')).toBeUndefined();
  });

  it('sweep-finalized reject (empty resolver id) → the system actor decides', async () => {
    seedApproval('appr-ghost', 'install_packages', { apt: ['jq'], npm: [] });
    const approval = getPendingApproval('appr-ghost')!;
    const session = getSession('sess-1')!;

    await finalizeReject(approval, session, '', 'approver never replied');

    const all = events();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      actor: { type: 'system', id: 'host' },
      origin: { transport: 'channel' },
      action: 'approvals.decide',
      outcome: 'rejected',
      correlation_id: 'appr-ghost',
    });
  });
});
