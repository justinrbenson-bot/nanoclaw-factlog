/**
 * mayResolve matrix — the one click-authorization rule for every hold.
 *
 * Covers each approver-rule kind × clicker role × approver scope, including:
 *  - exclusive named approvers (a2a policy semantics: nobody else, not even
 *    an owner, may resolve)
 *  - admins-of-scope with and without a delivered approver (the
 *    sender/channel "named-or-admin" semantic)
 *  - the null-anchor variant (owners + global admins only)
 *  - the D1 fix: a 'global'-scope hold rejects a scoped admin's click even
 *    though the approver rule would otherwise accept it
 *
 * Plus an end-to-end D1 regression through the real response handler: a
 * global-blast CLI hold (e.g. roles grant) clicked by a scoped admin is
 * ignored; the owner's click resolves it.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { initSessionFolder } from '../../session-manager.js';
import { approverRuleOf, mayResolve } from './approver-rule.js';
import { registerApprovalHandler } from './primitive.js';
import { handleApprovalsResponse } from './response-handler.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approver-rule' };
});

const TEST_DIR = '/tmp/nanoclaw-test-approver-rule';

function now() {
  return new Date().toISOString();
}

const OWNER = 'slack:owner';
const GLOBAL_ADMIN = 'slack:global-admin';
const SCOPED_ADMIN = 'slack:scoped-admin'; // admin @ ag-1
const OTHER_ADMIN = 'slack:other-admin'; // admin @ ag-2
const DELIVEREE = 'slack:deliveree'; // no role — the user a card was delivered to
const RANDO = 'slack:rando'; // no role

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'One', folder: 'one', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-2', name: 'Two', folder: 'two', agent_provider: null, created_at: now() });

  for (const id of [OWNER, GLOBAL_ADMIN, SCOPED_ADMIN, OTHER_ADMIN, DELIVEREE, RANDO]) {
    upsertUser({ id, kind: 'slack', display_name: id, created_at: now() });
  }
  grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  grantRole({ user_id: GLOBAL_ADMIN, role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
  grantRole({ user_id: SCOPED_ADMIN, role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
  grantRole({ user_id: OTHER_ADMIN, role: 'admin', agent_group_id: 'ag-2', granted_by: null, granted_at: now() });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('mayResolve matrix', () => {
  it('exclusive: only the named user, regardless of rank', () => {
    const e = { kind: 'exclusive', approverUserId: DELIVEREE } as const;
    expect(mayResolve(e, 'group', DELIVEREE)).toBe(true);
    expect(mayResolve(e, 'group', OWNER)).toBe(false);
    expect(mayResolve(e, 'group', GLOBAL_ADMIN)).toBe(false);
    expect(mayResolve(e, 'group', SCOPED_ADMIN)).toBe(false);
    expect(mayResolve(e, 'group', RANDO)).toBe(false);
    expect(mayResolve(e, 'group', null)).toBe(false);
  });

  it('exclusive ∩ global scope: the named user must also be owner/global admin', () => {
    expect(mayResolve({ kind: 'exclusive', approverUserId: DELIVEREE }, 'global', DELIVEREE)).toBe(false);
    expect(mayResolve({ kind: 'exclusive', approverUserId: OWNER }, 'global', OWNER)).toBe(true);
    expect(mayResolve({ kind: 'exclusive', approverUserId: GLOBAL_ADMIN }, 'global', GLOBAL_ADMIN)).toBe(true);
  });

  it('admins-of-scope(group) with a delivered approver: named-or-admin', () => {
    const e = { kind: 'admins-of-scope', agentGroupId: 'ag-1', deliveredTo: DELIVEREE } as const;
    expect(mayResolve(e, 'group', DELIVEREE)).toBe(true); // delivered-to shortcut
    expect(mayResolve(e, 'group', SCOPED_ADMIN)).toBe(true);
    expect(mayResolve(e, 'group', GLOBAL_ADMIN)).toBe(true);
    expect(mayResolve(e, 'group', OWNER)).toBe(true);
    expect(mayResolve(e, 'group', OTHER_ADMIN)).toBe(false); // admin of another group
    expect(mayResolve(e, 'group', RANDO)).toBe(false);
    expect(mayResolve(e, 'group', null)).toBe(false);
  });

  it('admins-of-scope(group) without a delivered approver: pure admin chain', () => {
    const e = { kind: 'admins-of-scope', agentGroupId: 'ag-1', deliveredTo: null } as const;
    expect(mayResolve(e, 'group', SCOPED_ADMIN)).toBe(true);
    expect(mayResolve(e, 'group', GLOBAL_ADMIN)).toBe(true);
    expect(mayResolve(e, 'group', OWNER)).toBe(true);
    expect(mayResolve(e, 'group', DELIVEREE)).toBe(false);
    expect(mayResolve(e, 'group', OTHER_ADMIN)).toBe(false);
  });

  it('admins-of-scope(null): owners and global admins only', () => {
    const e = { kind: 'admins-of-scope', agentGroupId: null, deliveredTo: null } as const;
    expect(mayResolve(e, 'group', OWNER)).toBe(true);
    expect(mayResolve(e, 'group', GLOBAL_ADMIN)).toBe(true);
    expect(mayResolve(e, 'group', SCOPED_ADMIN)).toBe(false);
    expect(mayResolve(e, 'group', RANDO)).toBe(false);
  });

  it('admins-of-scope(null) with a delivered approver keeps the delivered-to shortcut (channel semantics)', () => {
    const e = { kind: 'admins-of-scope', agentGroupId: null, deliveredTo: DELIVEREE } as const;
    expect(mayResolve(e, 'group', DELIVEREE)).toBe(true);
    expect(mayResolve(e, 'group', SCOPED_ADMIN)).toBe(false);
  });

  it('D1 overlay: global scope rejects everyone below owner/global admin', () => {
    const e = { kind: 'admins-of-scope', agentGroupId: 'ag-1', deliveredTo: DELIVEREE } as const;
    expect(mayResolve(e, 'global', SCOPED_ADMIN)).toBe(false); // the D1 exploit, closed
    expect(mayResolve(e, 'global', DELIVEREE)).toBe(false);
    expect(mayResolve(e, 'global', OTHER_ADMIN)).toBe(false);
    expect(mayResolve(e, 'global', OWNER)).toBe(true);
    expect(mayResolve(e, 'global', GLOBAL_ADMIN)).toBe(true);
  });

  it('approverRuleOf maps row columns onto the rule', () => {
    const base = { agent_group_id: 'ag-1' };
    expect(approverRuleOf({ ...base, approver_rule: 'exclusive', approver_user_id: DELIVEREE })).toEqual({
      kind: 'exclusive',
      approverUserId: DELIVEREE,
    });
    expect(approverRuleOf({ ...base, approver_rule: 'admins-of-scope', approver_user_id: DELIVEREE })).toEqual({
      kind: 'admins-of-scope',
      agentGroupId: 'ag-1',
      deliveredTo: DELIVEREE,
    });
    expect(approverRuleOf({ ...base, approver_rule: 'admins-of-scope', approver_user_id: null })).toEqual({
      kind: 'admins-of-scope',
      agentGroupId: 'ag-1',
      deliveredTo: null,
    });
    // Malformed exclusive (no named user) falls back to the admin chain
    // instead of bricking the hold.
    expect(approverRuleOf({ ...base, approver_rule: 'exclusive', approver_user_id: null })).toEqual({
      kind: 'admins-of-scope',
      agentGroupId: 'ag-1',
      deliveredTo: null,
    });
  });
});

describe('D1 regression — global-blast hold through the real response handler', () => {
  beforeEach(() => {
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
    initSessionFolder('ag-1', 'sess-1');
  });

  it("a scoped admin's click on a roles-grant-style hold is ignored; the owner's click resolves it", async () => {
    const applied: string[] = [];
    registerApprovalHandler('test_global_blast', async ({ userId }) => {
      applied.push(userId);
    });

    createPendingApproval({
      approval_id: 'appr-global-1',
      session_id: 'sess-1',
      request_id: 'appr-global-1',
      action: 'test_global_blast',
      payload: JSON.stringify({}),
      created_at: now(),
      agent_group_id: 'ag-1',
      title: 'CLI: roles-grant',
      options_json: JSON.stringify([]),
      approver_scope: 'global',
    });

    // Scoped admin of the requesting group clicks approve — pre-D1 this
    // resolved a global privilege grant; now it is ignored and the hold stays.
    const claimedByScoped = await handleApprovalsResponse({
      questionId: 'appr-global-1',
      value: 'approve',
      userId: 'scoped-admin',
      channelType: 'slack',
      platformId: 'dm-scoped',
      threadId: null,
    });
    expect(claimedByScoped).toBe(true);
    expect(applied).toEqual([]);
    expect(getPendingApproval('appr-global-1')).toBeDefined();

    // The owner's click resolves it.
    await handleApprovalsResponse({
      questionId: 'appr-global-1',
      value: 'approve',
      userId: 'owner',
      channelType: 'slack',
      platformId: 'dm-owner',
      threadId: null,
    });
    expect(applied).toEqual([OWNER]);
    expect(getPendingApproval('appr-global-1')).toBeUndefined();
  });
});
