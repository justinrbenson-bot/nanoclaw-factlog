/**
 * Guard decision-function unit tests: the baseline is the decision (allow /
 * hold / deny returned as-is, non-catalog actions allow), grant semantics
 * (satisfies holds, never denies; invalid → refuse), and the fail-closed
 * posture on a throwing baseline.
 *
 * Uses synthetic catalog actions registered per test — the registry is
 * per-worker module state with no reset, so action names are unique.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApproverRule } from '../types.js';
import { guard } from './guard.js';
import { registerGuardedAction } from './catalog.js';
import { ALLOW, DENY, HOLD, type GuardInput } from './types.js';

const mockGetPendingApproval = vi.fn();
vi.mock('../db/sessions.js', () => ({
  getPendingApproval: (...args: unknown[]) => mockGetPendingApproval(...args),
}));
vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const AGENT = { kind: 'agent', agentGroupId: 'ag-1', sessionId: 'sess-1' } as const;

function input(action: string, extra: Partial<GuardInput> = {}): GuardInput {
  return { action, actor: AGENT, payload: {}, ...extra };
}

const AOS_G1: ApproverRule = { kind: 'admins-of-scope', agentGroupId: 'ag-1', deliveredTo: null };

beforeEach(() => {
  mockGetPendingApproval.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the baseline is the decision', () => {
  it('non-catalog action → allow', () => {
    expect(guard(input('test.unregistered-read')).effect).toBe('allow');
  });

  it('baseline allow → allow', () => {
    registerGuardedAction({ action: 't.allow1', baseline: () => ALLOW('ok') });
    expect(guard(input('t.allow1')).effect).toBe('allow');
  });

  it('baseline hold → hold, carrying the approver rule and scope', () => {
    registerGuardedAction({ action: 't.hold1', baseline: () => HOLD(AOS_G1, 'global', 'needs approval') });
    const d = guard(input('t.hold1'));
    expect(d.effect).toBe('hold');
    if (d.effect === 'hold') {
      expect(d.approverRule).toEqual(AOS_G1);
      expect(d.approverScope).toBe('global');
    }
  });

  it('baseline deny → deny, carrying the reason', () => {
    registerGuardedAction({ action: 't.deny1', baseline: () => DENY('structurally unauthorized') });
    const d = guard(input('t.deny1'));
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.reason).toBe('structurally unauthorized');
  });
});

describe('grants', () => {
  const grantRow = (action: string) =>
    ({ approval_id: 'appr-1', action, payload: '{}' }) as unknown as NonNullable<GuardInput['grant']>;

  it('a valid live grant satisfies a hold', () => {
    registerGuardedAction({
      action: 't.g1',
      approvalAction: 'g1_approved',
      baseline: () => HOLD(AOS_G1, 'group', 'b'),
    });
    const grant = grantRow('g1_approved');
    mockGetPendingApproval.mockReturnValue(grant);
    expect(guard(input('t.g1', { grant })).effect).toBe('allow');
  });

  it('a grant never satisfies a deny — the baseline is re-checked live', () => {
    registerGuardedAction({ action: 't.g2', approvalAction: 'g2_approved', baseline: () => DENY('revoked since') });
    const grant = grantRow('g2_approved');
    mockGetPendingApproval.mockReturnValue(grant);
    const d = guard(input('t.g2', { grant }));
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.reason).toBe('revoked since');
  });

  it('a dead grant (row deleted) refuses instead of re-holding', () => {
    registerGuardedAction({
      action: 't.g3',
      approvalAction: 'g3_approved',
      baseline: () => HOLD(AOS_G1, 'group', 'b'),
    });
    mockGetPendingApproval.mockReturnValue(undefined);
    const d = guard(input('t.g3', { grant: grantRow('g3_approved') }));
    expect(d.effect).toBe('deny');
  });

  it("a grant for a different action doesn't transfer", () => {
    registerGuardedAction({
      action: 't.g4',
      approvalAction: 'g4_approved',
      baseline: () => HOLD(AOS_G1, 'group', 'b'),
    });
    const grant = grantRow('other_action');
    mockGetPendingApproval.mockReturnValue(grant);
    expect(guard(input('t.g4', { grant })).effect).toBe('deny');
  });

  it('a domain grantMatches binding can refuse a payload mismatch', () => {
    registerGuardedAction({
      action: 't.g5',
      approvalAction: 'g5_approved',
      grantMatches: () => false,
      baseline: () => HOLD(AOS_G1, 'group', 'b'),
    });
    const grant = grantRow('g5_approved');
    mockGetPendingApproval.mockReturnValue(grant);
    expect(guard(input('t.g5', { grant })).effect).toBe('deny');
  });

  it('a grant on an already-allowed action is a no-op', () => {
    registerGuardedAction({ action: 't.g6', approvalAction: 'g6_approved', baseline: () => ALLOW('ok') });
    const grant = grantRow('g6_approved');
    mockGetPendingApproval.mockReturnValue(grant);
    expect(guard(input('t.g6', { grant })).effect).toBe('allow');
  });
});

describe('fail-closed posture', () => {
  it('a throwing baseline denies', () => {
    registerGuardedAction({
      action: 't.f1',
      baseline: () => {
        throw new Error('boom');
      },
    });
    expect(guard(input('t.f1')).effect).toBe('deny');
  });
});
