/**
 * Guard decision-function unit tests: the strictest-wins lattice
 * (deny > hold > allow), per-cell rule×baseline composition, hold∧hold
 * eligibility intersection (incl. the empty-intersection owner escalation),
 * grant semantics (satisfies holds, never denies; invalid → refuse), the
 * non-catalog allow, and the fail-closed posture on throwing sources.
 *
 * Uses synthetic catalog actions/rules registered per test — the registries
 * are per-worker module state with no reset, so action names are unique.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApproverEligibility } from '../types.js';
import { guard } from './guard.js';
import { registerGuardedAction } from './catalog.js';
import { registerRuleSource } from './rules.js';
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

const AOS_G1: ApproverEligibility = { kind: 'admins-of-scope', agentGroupId: 'ag-1', deliveredTo: null };
const AOS_G2: ApproverEligibility = { kind: 'admins-of-scope', agentGroupId: 'ag-2', deliveredTo: null };
const EX_DANA: ApproverEligibility = { kind: 'exclusive', approverUserId: 'tg:dana' };
const EX_SAM: ApproverEligibility = { kind: 'exclusive', approverUserId: 'tg:sam' };

beforeEach(() => {
  mockGetPendingApproval.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('lattice — strictest wins', () => {
  it('non-catalog action → allow', () => {
    expect(guard(input('test.unregistered-read')).effect).toBe('allow');
  });

  it('baseline allow + no rules → allow', () => {
    registerGuardedAction({ action: 't.allow1', baseline: () => ALLOW('ok') });
    expect(guard(input('t.allow1')).effect).toBe('allow');
  });

  it('baseline allow + rule hold → hold (a rule tightens a structural allow)', () => {
    registerGuardedAction({ action: 't.allow2', baseline: () => ALLOW('ok') });
    registerRuleSource((i) => (i.action === 't.allow2' ? [{ effect: 'hold', eligibility: EX_DANA, reason: 'r' }] : []));
    const d = guard(input('t.allow2'));
    expect(d.effect).toBe('hold');
    if (d.effect === 'hold') expect(d.eligibility).toEqual(EX_DANA);
  });

  it('baseline deny + rule hold → deny (the ghost-policy cell: deny beats hold)', () => {
    registerGuardedAction({ action: 't.deny1', baseline: () => DENY('structurally unauthorized') });
    registerRuleSource((i) => (i.action === 't.deny1' ? [{ effect: 'hold', eligibility: EX_DANA, reason: 'r' }] : []));
    const d = guard(input('t.deny1'));
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.reason).toBe('structurally unauthorized');
  });

  it('baseline hold + rule deny → deny', () => {
    registerGuardedAction({ action: 't.deny2', baseline: () => HOLD(AOS_G1, 'group', 'needs approval') });
    registerRuleSource((i) => (i.action === 't.deny2' ? [{ effect: 'deny', reason: 'rule says no' }] : []));
    expect(guard(input('t.deny2')).effect).toBe('deny');
  });

  it('baseline allow + rule deny → deny (nothing loosens a rule)', () => {
    registerGuardedAction({ action: 't.deny3', baseline: () => ALLOW('ok') });
    registerRuleSource((i) => (i.action === 't.deny3' ? [{ effect: 'deny', reason: 'no' }] : []));
    expect(guard(input('t.deny3')).effect).toBe('deny');
  });

  it('rules can never allow: an empty rule set leaves the baseline decision intact', () => {
    registerGuardedAction({ action: 't.hold1', baseline: () => HOLD(AOS_G1, 'group', 'needs approval') });
    expect(guard(input('t.hold1')).effect).toBe('hold');
  });
});

describe('hold ∧ hold — eligibility intersection', () => {
  it('identical admin scopes stay that scope', () => {
    registerGuardedAction({ action: 't.ii1', baseline: () => HOLD(AOS_G1, 'group', 'b') });
    registerRuleSource((i) => (i.action === 't.ii1' ? [{ effect: 'hold', eligibility: AOS_G1, reason: 'r' }] : []));
    const d = guard(input('t.ii1'));
    expect(d.effect).toBe('hold');
    if (d.effect === 'hold') expect(d.eligibility).toEqual(AOS_G1);
  });

  it('different admin scopes intersect to the global chain (owners/global admins are in every scope)', () => {
    registerGuardedAction({ action: 't.ii2', baseline: () => HOLD(AOS_G1, 'group', 'b') });
    registerRuleSource((i) => (i.action === 't.ii2' ? [{ effect: 'hold', eligibility: AOS_G2, reason: 'r' }] : []));
    const d = guard(input('t.ii2'));
    expect(d.effect).toBe('hold');
    if (d.effect === 'hold') {
      expect(d.eligibility).toEqual({ kind: 'admins-of-scope', agentGroupId: null, deliveredTo: null });
    }
  });

  it('exclusive ∩ admin scope keeps the named approver (the more specific tightening)', () => {
    registerGuardedAction({ action: 't.ii3', baseline: () => HOLD(AOS_G1, 'group', 'b') });
    registerRuleSource((i) => (i.action === 't.ii3' ? [{ effect: 'hold', eligibility: EX_DANA, reason: 'r' }] : []));
    const d = guard(input('t.ii3'));
    expect(d.effect).toBe('hold');
    if (d.effect === 'hold') expect(d.eligibility).toEqual(EX_DANA);
  });

  it('two different exclusive approvers = empty intersection → escalates to the global chain', () => {
    registerGuardedAction({ action: 't.ii4', baseline: () => HOLD(EX_SAM, 'group', 'b') });
    registerRuleSource((i) => (i.action === 't.ii4' ? [{ effect: 'hold', eligibility: EX_DANA, reason: 'r' }] : []));
    const d = guard(input('t.ii4'));
    expect(d.effect).toBe('hold');
    if (d.effect === 'hold') {
      expect(d.eligibility).toEqual({ kind: 'admins-of-scope', agentGroupId: null, deliveredTo: null });
    }
  });

  it('approver scope composes as max: any global leg makes the hold global', () => {
    registerGuardedAction({ action: 't.ii5', baseline: () => HOLD(AOS_G1, 'global', 'b') });
    registerRuleSource((i) => (i.action === 't.ii5' ? [{ effect: 'hold', eligibility: AOS_G1, reason: 'r' }] : []));
    const d = guard(input('t.ii5'));
    expect(d.effect).toBe('hold');
    if (d.effect === 'hold') expect(d.approverScope).toBe('global');
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

  it('a throwing rule source denies the whole decision', () => {
    registerGuardedAction({ action: 't.f2', baseline: () => ALLOW('ok') });
    registerRuleSource((i) => {
      if (i.action === 't.f2') throw new Error('rule source down');
      return [];
    });
    expect(guard(input('t.f2')).effect).toBe('deny');
  });
});
