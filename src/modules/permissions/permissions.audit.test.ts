/**
 * Permissions audit adapters: card decisions and the name interceptor.
 * Inners are stubs — each wrapper's contract is "call through, emit the
 * right event (or none), coerce back to claimed".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appended = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, AUDIT_ENABLED: true };
});

vi.mock('../../audit/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../audit/store.js')>();
  return {
    ...actual,
    appendAuditLine: (line: string) => {
      appended.lines.push(line);
    },
  };
});

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { auditChannelDecision, auditChannelNameInterceptor, auditSenderDecision } from './permissions.audit.js';

const PAYLOAD = {
  questionId: 'q1',
  value: 'approve',
  userId: 'U1',
  channelType: 'slack',
  platformId: 'p',
  threadId: null,
};

function events(): Array<Record<string, any>> {
  return appended.lines.map((l) => JSON.parse(l));
}

beforeEach(() => {
  appended.lines.length = 0;
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
