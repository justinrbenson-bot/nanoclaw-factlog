/**
 * OneCLI credential wrappers: hold + the three resolution paths. Inners are
 * stubs — each wrapper's contract is "call through, emit the right event
 * (or none)". The requestApproval decorator and runApprovedHandler are
 * covered end-to-end in primitive.audit.test.ts / response-handler.audit.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appended = vi.hoisted(() => ({ lines: [] as string[] }));
const db = vi.hoisted(() => ({ row: undefined as Record<string, unknown> | undefined }));

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

vi.mock('../../db/sessions.js', () => ({
  getPendingApproval: () => db.row,
}));

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: () => undefined,
}));

import { auditOneCliDecision, auditOneCliExpiry, auditOneCliHold, auditOneCliSweep } from './approvals.audit.js';

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
