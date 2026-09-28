import { describe, expect, it } from 'vitest';
import type { RuleEvaluation, RuleId } from '@refund/shared';
import { checkOverride, hardBlockRuleIds, type OverrideAttempt } from '../policy/overrideGuard.js';

/**
 * What an admin may overturn.
 *
 * The override endpoint is the one place a person can overrule the whole policy
 * engine, so the interesting question is not "can they" but "did the system make
 * them notice what they were undoing". These tests pin the gradation: money never
 * moves without an approval, an approval over a hard denial needs an explicit
 * acknowledgement, and an order that has already been paid back cannot be paid
 * back again at all.
 */

function evaluation(ruleId: RuleId, outcome: RuleEvaluation['outcome']): RuleEvaluation {
  return {
    ruleId,
    ruleClass: 'eligibility',
    scope: 'order',
    outcome,
    evidence: `${ruleId} fired`,
    policyRef: 'REFUND_POLICY.md §1.0',
    itemIds: [],
  };
}

const R01_DENIAL: readonly RuleEvaluation[] = [evaluation('R-01', 'deny'), evaluation('R-04', 'pass')];
const NO_DENIAL: readonly RuleEvaluation[] = [evaluation('R-04', 'approve'), evaluation('R-01', 'pass')];

function attempt(overrides: Partial<OverrideAttempt> = {}): OverrideAttempt {
  return {
    current: 'denied',
    next: 'approved',
    trace: NO_DENIAL,
    alreadyFullyRefunded: false,
    acknowledged: false,
    ...overrides,
  };
}

describe('hard block detection', () => {
  it('lists the rules that refused for a money or integrity reason', () => {
    expect(hardBlockRuleIds(R01_DENIAL)).toEqual(['R-01']);
  });

  it('ignores a rule that only passed or escalated', () => {
    const trace = [evaluation('R-03', 'escalate'), evaluation('R-12', 'escalate'), evaluation('R-04', 'approve')];

    expect(hardBlockRuleIds(trace)).toEqual([]);
  });

  it('de-duplicates repeated evaluations of the same rule', () => {
    const trace = [evaluation('R-02', 'deny'), evaluation('R-02', 'deny'), evaluation('R-02', 'deny')];

    expect(hardBlockRuleIds(trace)).toEqual(['R-02']);
  });

  it('covers every money and integrity rule it claims to', () => {
    for (const ruleId of ['R-01', 'R-02', 'R-05', 'R-06', 'R-14'] as const) {
      expect(hardBlockRuleIds([evaluation(ruleId, 'deny')])).toEqual([ruleId]);
    }
  });
});

describe('overrides that authorise money', () => {
  it('requires an acknowledgement when a hard denial is overturned', () => {
    const refusal = checkOverride(attempt({ trace: R01_DENIAL }));

    expect(refusal?.kind).toBe('needs_acknowledgement');
    expect(refusal?.kind === 'needs_acknowledgement' && refusal.ruleIds).toEqual(['R-01']);
  });

  it('tells the agent what to do next, not just "no"', () => {
    const refusal = checkOverride(attempt({ trace: R01_DENIAL }));

    // A refusal nobody can act on is a support ticket.
    expect(refusal?.message).toContain('acknowledgeHardBlock');
    expect(refusal?.message).toContain('R-01');
  });

  it('allows the approval once the hard block is acknowledged', () => {
    expect(checkOverride(attempt({ trace: R01_DENIAL, acknowledged: true }))).toBeNull();
  });

  it('allows an approval the policy never hard-refused', () => {
    // No hard block, so nothing to acknowledge: the ordinary goodwill case.
    expect(checkOverride(attempt({ current: 'escalated', trace: NO_DENIAL }))).toBeNull();
  });

  it('refuses outright when the order has already been refunded in full', () => {
    // Not a matter of judgement: the money is gone, so approving authorises a
    // second payment of the same amount.
    const refusal = checkOverride(attempt({ trace: R01_DENIAL, acknowledged: true, alreadyFullyRefunded: true }));

    expect(refusal?.kind).toBe('impossible');
  });

  it('does not let an acknowledgement unlock an already-refunded order', () => {
    // The one guarantee that is absolute: acknowledging a hard block buys you
    // everything except this.
    expect(
      checkOverride(attempt({ trace: NO_DENIAL, alreadyFullyRefunded: true, acknowledged: true }))?.kind,
    ).toBe('impossible');
  });
});

describe('overrides that move no money', () => {
  it('allows any tightening without acknowledgement', () => {
    for (const next of ['denied', 'escalated'] as const) {
      expect(checkOverride(attempt({ current: 'approved', next, trace: NO_DENIAL }))).toBeNull();
    }
  });

  it('lets an admin re-open a hard denial for human review', () => {
    // Denied -> escalated moves no money. Requiring an acknowledgement here would
    // be a misleading prompt: the agent is not reversing the refusal, they are
    // asking for a person to look at it.
    expect(checkOverride(attempt({ current: 'denied', next: 'escalated', trace: R01_DENIAL }))).toBeNull();
  });

  it('allows re-approving an already approved request', () => {
    expect(checkOverride(attempt({ current: 'approved', next: 'approved', trace: R01_DENIAL }))).toBeNull();
    expect(
      checkOverride(attempt({ current: 'approved', next: 'approved', trace: R01_DENIAL, acknowledged: true })),
    ).toBeNull();
  });
});
