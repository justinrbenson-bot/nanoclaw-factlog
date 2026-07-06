/**
 * agents.create adapter for the ungated door. The inner is a stub — the
 * contract is "call through, emit success/failure naming parent and child".
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

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: () => undefined,
}));

import type { Session } from '../../types.js';
import { auditCreateAgentDirect } from './create-agent.audit.js';

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

function events(): Array<Record<string, any>> {
  return appended.lines.map((l) => JSON.parse(l));
}

beforeEach(() => {
  appended.lines.length = 0;
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
