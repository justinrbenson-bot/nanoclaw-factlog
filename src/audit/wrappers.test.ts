/**
 * Out-of-band seam wrappers: permissions card decisions, the ungated
 * create-agent door, and the four OneCLI paths. Inners are stubs — each
 * wrapper's contract is "call through, emit the right event (or none)".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appended = vi.hoisted(() => ({ lines: [] as string[] }));
const db = vi.hoisted(() => ({ row: undefined as Record<string, unknown> | undefined }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, AUDIT_ENABLED: true };
});

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.js')>();
  return {
    ...actual,
    appendAuditLine: (line: string) => {
      appended.lines.push(line);
    },
  };
});

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../db/sessions.js', () => ({
  getPendingApproval: () => db.row,
}));

vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroup: () => undefined,
}));

import type { Session } from '../types.js';
import {
  auditChannelDecision,
  auditChannelNameInterceptor,
  auditCreateAgentDirect,
  auditOneCliDecision,
  auditOneCliExpiry,
  auditOneCliHold,
  auditOneCliSweep,
  auditSenderDecision,
} from './wrappers.js';

const PAYLOAD = {
  questionId: 'q1',
  value: 'approve',
  userId: 'U1',
  channelType: 'slack',
  platformId: 'p',
  threadId: null,
};

const SESSION: Session = {
  id: 'sess-1',
  agent_group_id: 'ag-parent',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

const ONECLI_ROW = {
  approval_id: 'oa-abc123',
  agent_group_id: 'ag-1',
  channel_type: 'telegram',
  payload: JSON.stringify({
    oneCliRequestId: 'uuid-1',
    method: 'POST',
    host: 'api.notion.com',
    path: '/v1/pages',
    bodyPreview: 'SECRET BODY CONTENT',
    agent: { externalId: 'ag-1', name: 'Agent' },
    approver: 'slack:U0ADMIN',
  }),
};

function events(): Array<Record<string, any>> {
  return appended.lines.map((l) => JSON.parse(l));
}

beforeEach(() => {
  appended.lines.length = 0;
  db.row = undefined;
});

describe('auditSenderDecision', () => {
  const decision = {
    approved: true,
    senderIdentity: 'slack:U0NEW',
    agentGroupId: 'ag-1',
    messagingGroupId: 'mg-1',
    approverId: 'slack:U0ADMIN',
    channelType: 'slack',
  };

  it('emits senders.allow success on approve and coerces claimed', async () => {
    const wrapped = auditSenderDecision(async () => ({ claimed: true, decision }));
    expect(await wrapped(PAYLOAD)).toBe(true);
    const [event] = events();
    expect(event).toMatchObject({
      actor: { type: 'human', id: 'slack:U0ADMIN' },
      origin: { transport: 'channel', channel: 'slack' },
      action: 'senders.allow',
      outcome: 'success',
      correlation_id: null,
      details: {},
    });
    expect(event.resources).toEqual([
      { type: 'user', id: 'slack:U0NEW' },
      { type: 'agent_group', id: 'ag-1' },
      { type: 'messaging_group', id: 'mg-1' },
    ]);
  });

  it('emits rejected on deny', async () => {
    const wrapped = auditSenderDecision(async () => ({ claimed: true, decision: { ...decision, approved: false } }));
    await wrapped(PAYLOAD);
    expect(events()[0].outcome).toBe('rejected');
  });

  it('emits nothing without a decision (unclaimed or unauthorized click)', async () => {
    const unclaimed = auditSenderDecision(async () => ({ claimed: false }));
    const unauthorized = auditSenderDecision(async () => ({ claimed: true }));
    expect(await unclaimed(PAYLOAD)).toBe(false);
    expect(await unauthorized(PAYLOAD)).toBe(true);
    expect(appended.lines).toHaveLength(0);
  });
});

describe('auditChannelDecision / auditChannelNameInterceptor', () => {
  const base = { messagingGroupId: 'mg-1', approverId: 'slack:U0ADMIN', channelType: 'slack' };

  it('maps connected → success with the wired agent group', async () => {
    const wrapped = auditChannelDecision(async () => ({
      claimed: true,
      decision: { kind: 'connected' as const, agentGroupId: 'ag-1', createdAgentGroup: false, ...base },
    }));
    await wrapped(PAYLOAD);
    const [event] = events();
    expect(event).toMatchObject({
      action: 'channels.register',
      outcome: 'success',
      details: { created_agent_group: false },
    });
    expect(event.resources).toEqual([
      { type: 'messaging_group', id: 'mg-1' },
      { type: 'agent_group', id: 'ag-1' },
    ]);
  });

  it('maps rejected and failed outcomes', async () => {
    await auditChannelDecision(async () => ({ claimed: true, decision: { kind: 'rejected' as const, ...base } }))(
      PAYLOAD,
    );
    await auditChannelDecision(async () => ({
      claimed: true,
      decision: { kind: 'failed' as const, reason: 'target agent group no longer exists', ...base },
    }))(PAYLOAD);
    const all = events();
    expect(all[0]).toMatchObject({ action: 'channels.register', outcome: 'rejected' });
    expect(all[1]).toMatchObject({ action: 'channels.register', outcome: 'failure' });
    expect(all[1].details.reason).toContain('no longer exists');
  });

  it('records the interceptor-created agent group — the third creation door', async () => {
    const wrapped = auditChannelNameInterceptor(async () => ({
      claimed: true,
      decision: {
        kind: 'connected' as const,
        agentGroupId: 'ag-new',
        createdAgentGroup: true,
        agentName: 'Scout',
        ...base,
      },
    }));
    expect(await wrapped({} as never)).toBe(true);
    const [event] = events();
    expect(event.details).toMatchObject({ created_agent_group: true, agent_name: 'Scout' });
    expect(event.resources).toContainEqual({ type: 'agent_group', id: 'ag-new' });
  });
});

describe('auditCreateAgentDirect', () => {
  it('emits agents.create success naming parent and child', async () => {
    const wrapped = auditCreateAgentDirect(async () => ({
      ok: true,
      agentGroupId: 'ag-child',
      name: 'Scout',
      localName: 'scout',
      folder: 'scout',
    }));
    const result = await wrapped('Scout', 'be helpful', SESSION, { id: 'ag-parent' } as never, () => {});
    expect(result.ok).toBe(true);
    const [event] = events();
    expect(event).toMatchObject({
      actor: { type: 'agent', id: 'ag-parent' },
      action: 'agents.create',
      outcome: 'success',
      correlation_id: null,
      details: { name: 'Scout', parent: 'ag-parent', folder: 'scout', instructions_chars: 10 },
    });
    expect(event.resources).toEqual([
      { type: 'agent_group', id: 'ag-parent' },
      { type: 'agent_group', id: 'ag-child' },
    ]);
  });

  it('emits failure with the reason when creation is refused', async () => {
    const wrapped = auditCreateAgentDirect(async () => ({ ok: false, reason: 'destination name collision' }));
    await wrapped('Scout', null, SESSION, { id: 'ag-parent' } as never, () => {});
    const [event] = events();
    expect(event).toMatchObject({ outcome: 'failure', details: { reason: 'destination name collision' } });
  });
});

describe('OneCLI wrappers', () => {
  it('hold: emits pending from the row — shape only, never the body preview', () => {
    const inner = vi.fn();
    auditOneCliHold(inner)(ONECLI_ROW);
    expect(inner).toHaveBeenCalledOnce();
    const [event] = events();
    expect(event).toMatchObject({
      actor: { type: 'agent', id: 'ag-1' },
      origin: { transport: 'container' },
      action: 'onecli.credential.use',
      outcome: 'pending',
      correlation_id: 'oa-abc123',
      details: { method: 'POST', host: 'api.notion.com', path: '/v1/pages', body_preview_chars: 19 },
    });
    expect(event.resources).toContainEqual({ type: 'user', id: 'slack:U0ADMIN' });
    expect(JSON.stringify(event)).not.toContain('SECRET BODY CONTENT');
  });

  it('decision: emits approvals.decide with the clicking human when resolved', () => {
    db.row = ONECLI_ROW;
    const wrapped = auditOneCliDecision(() => true);
    expect(wrapped('oa-abc123', 'approve', 'slack:U0ADMIN')).toBe(true);
    const [event] = events();
    expect(event).toMatchObject({
      actor: { type: 'human', id: 'slack:U0ADMIN' },
      origin: { transport: 'channel', channel: 'slack' },
      action: 'approvals.decide',
      outcome: 'approved',
      correlation_id: 'oa-abc123',
      details: { gated_action: 'onecli.credential.use' },
    });
  });

  it('decision: emits nothing when the resolver is gone (inner returns false)', () => {
    db.row = ONECLI_ROW;
    expect(auditOneCliDecision(() => false)('oa-abc123', 'approve', 'slack:U0ADMIN')).toBe(false);
    expect(appended.lines).toHaveLength(0);
  });

  it('expiry: the system actor rejects with the reason', async () => {
    db.row = ONECLI_ROW;
    await auditOneCliExpiry(async () => {})('oa-abc123', 'no response');
    const [event] = events();
    expect(event).toMatchObject({
      actor: { type: 'system', id: 'host' },
      origin: { transport: 'channel', channel: 'telegram' },
      outcome: 'rejected',
      details: { reason: 'expired: no response' },
    });
  });

  it('sweep: one system rejection per orphaned row', async () => {
    const rows = [ONECLI_ROW, { ...ONECLI_ROW, approval_id: 'oa-second' }];
    await auditOneCliSweep(
      async () => {},
      () => rows as never,
    )();
    const all = events();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.correlation_id)).toEqual(['oa-abc123', 'oa-second']);
    expect(all.every((e) => e.actor.type === 'system' && e.details.reason === 'host restarted')).toBe(true);
  });
});
