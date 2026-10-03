import { describe, expect, it } from 'vitest';
import { ModelCircuitBreaker, runCandidates } from '../ai/breaker.js';
import { AiUnavailableError, type IntakeReply } from '../ai/analyzer.js';
import { FakeAnalyzer } from './fakeAnalyzer.js';
import { openMemoryDatabase } from '../db/connection.js';
import { seedDatabase } from '../db/seed.js';
import { seedShop } from '../shop/seed.js';
import { createUser } from '../shop/auth.js';
import { checkout } from '../shop/catalogue.js';
import { processRefundRequest, DEFAULT_DISCRETION, type PipelineDeps } from '../orchestrator.js';
import { TEST_NOW } from './helpers.js';

/**
 * What happens when the models are not answering.
 *
 * The provider outage is the failure this system is most likely to have and least
 * equipped for by default: nothing about the policy changes, every rule has already
 * run on order facts, and the only thing missing is the evidence. So the tests here
 * are about three things - the ladder's order, the customer's visibility of it, and
 * the breaker that stops every request re-paying for the same discovery.
 */

/** A clock the test owns, so no cooldowns are waited on. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('the circuit breaker', () => {
  const config = { failureThreshold: 3, resetAfterMs: 30_000 };

  it('lets a model through until it fails repeatedly', () => {
    const { now } = clock();
    const breaker = new ModelCircuitBreaker(config, now);

    expect(breaker.admit('m')).toBe(true);
    breaker.recordFailure('m');
    breaker.recordFailure('m');
    expect(breaker.admit('m')).toBe(true);

    breaker.recordFailure('m');
    expect(breaker.admit('m')).toBe(false);
    expect(breaker.reason(['m'])).toContain('m');
  });

  it('counts only consecutive failures, so one success resets it', () => {
    const { now } = clock();
    const breaker = new ModelCircuitBreaker(config, now);

    breaker.recordFailure('m');
    breaker.recordFailure('m');
    breaker.recordSuccess('m');
    breaker.recordFailure('m');

    // Three failures spread around a success is one failure, not three: a provider
    // flapping is not a provider that is down.
    expect(breaker.admit('m')).toBe(true);
  });

  it('admits exactly one probe after the cooldown', () => {
    const time = clock();
    const breaker = new ModelCircuitBreaker(config, time.now);

    for (let i = 0; i < 3; i += 1) {
      breaker.recordFailure('m');
    }
    expect(breaker.admit('m')).toBe(false);

    time.advance(30_000);
    expect(breaker.admit('m')).toBe(true);
    // The herd problem: a breaker that lets everyone through when it opens is not a
    // breaker.
    expect(breaker.admit('m')).toBe(false);
  });

  it('re-arms the cooldown when the probe fails, rather than probing every interval', () => {
    const time = clock();
    const breaker = new ModelCircuitBreaker(config, time.now);
    for (let i = 0; i < 3; i += 1) {
      breaker.recordFailure('m');
    }
    time.advance(30_000);
    expect(breaker.admit('m')).toBe(true);
    breaker.recordFailure('m');

    time.advance(10_000);
    expect(breaker.admit('m')).toBe(false);
  });

  it('reports a model as available while any candidate can still be tried', () => {
    const { now } = clock();
    const breaker = new ModelCircuitBreaker(config, now);
    for (let i = 0; i < 3; i += 1) {
      breaker.recordFailure('bad');
    }

    expect(breaker.reason(['bad', 'good'])).toBeNull();
    expect(breaker.reason(['bad'])).not.toBeNull();
    expect(breaker.allOpen(['bad', 'good'])).toBe(false);
  });
});

describe('the ladder walks candidates and skips what the breaker has open', () => {
  const config = { failureThreshold: 2, resetAfterMs: 60_000 };

  it('stops trying a model the breaker has open, and says so', async () => {
    const { now } = clock();
    const breaker = new ModelCircuitBreaker(config, now);
    for (let i = 0; i < 2; i += 1) {
      breaker.recordFailure('dead');
    }

    const tried: string[] = [];
    const result = await runCandidates<string>({
      candidates: ['dead', 'alive'],
      maxAttempts: 2,
      breaker,
      budget: AbortSignal.timeout(5_000),
      purpose: 'intake',
      attempt: (model) => {
        tried.push(model);
        return Promise.resolve({ ok: true, value: model });
      },
    });

    // The point of the whole thing: 'dead' is not probed at all.
    expect(tried).toEqual(['alive']);
    expect(result.ok).toBe(true);
  });

  it('names the skipped models in the failure, so "we knew" reads differently from "we tried"', async () => {
    const { now } = clock();
    const breaker = new ModelCircuitBreaker(config, now);
    for (let i = 0; i < 2; i += 1) {
      breaker.recordFailure('dead');
    }

    const result = await runCandidates<string>({
      candidates: ['dead'],
      maxAttempts: 1,
      breaker,
      budget: AbortSignal.timeout(5_000),
      purpose: 'intake',
      attempt: () => Promise.resolve({ ok: false, error: '503', retryable: true }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.skipped).toEqual(['dead']);
      expect(result.failures).toEqual([]);
      expect(result.reason).toContain('already tripping');
    }
  });

  it('does not retry a failure that says not to', async () => {
    const { now } = clock();
    const breaker = new ModelCircuitBreaker(config, now);
    let attempts = 0;

    await runCandidates<string>({
      candidates: ['m'],
      maxAttempts: 5,
      breaker,
      budget: AbortSignal.timeout(5_000),
      purpose: 'intake',
      attempt: () => {
        attempts += 1;
        return Promise.resolve({ ok: false, error: 'schema', retryable: false });
      },
    });

    // A shape the provider will not change on a second ask is not worth a second ask.
    expect(attempts).toBe(1);
  });
});

describe('the ladder, end to end', () => {
  it('tells the customer, retries once, and decides nothing if that also fails', async () => {
    const db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    seedShop(db, TEST_NOW);
    const user = createUser(
      db,
      { email: 'ladder@shop.test', password: 'a-good-password', name: 'Ladder Tester' },
      TEST_NOW,
    );
    const order = checkout(db, user.customerId, [{ productId: 'PRD-MUG-01', quantity: 1 }], TEST_NOW);

    const notified: string[] = [];
    let attempts = 0;
    // Fails every time a model is asked, however many times it is asked.
    const flaky: PipelineDeps = {
      analyzer: {
        ...FakeAnalyzer({ kind: 'heuristic' }),
        label: 'flaky (test)',
        analyze(): Promise<IntakeReply> {
          attempts += 1;
          return Promise.reject(new AiUnavailableError('503 from the provider'));
        },
      },
      recordAttempt: () => {},
      injectionAction: 'deny',
      discretion: DEFAULT_DISCRETION,
      notifyCustomer: (customerId) => notified.push(customerId),
    };

    const result = await processRefundRequest(db, flaky, {
      requestId: 'REQ-LADDER',
      customerId: user.customerId,
      orderId: order.id,
      message: 'The mug arrived broken and I would like a refund',
      itemIds: [],
      now: TEST_NOW,
    });

    // 1. The customer is told before anything else happens. This is the difference
    //    between "we are having trouble" and a spinner with no explanation on it.
    expect(notified).toEqual([user.customerId]);
    // 2. The model was asked, then asked again.
    expect(attempts).toBe(2);
    // 3. And then nothing was decided, because nothing could read the claim. The
    //    matcher does not step in: a pattern matcher reading a refund claim is a
    //    second, untested reader of a document that decides money, and the difference
    //    between "the model read this and the policy approved it" and "a regex read
    //    this and the policy approved it" is not a wording difference.
    expect(result.stage).toBe('decided');
    if (result.stage === 'decided') {
      expect(result.decision.decision).toBe('escalated');
      expect(result.decision.refundAmountCents).toBe(0);
      expect(result.extraction).toBeNull();
      expect(result.notice).toContain('could not read your message');
    }
    db.close();
  });

  it('escalates with an explanation when nothing can read the message', async () => {
    const db = openMemoryDatabase();
    seedDatabase(db, TEST_NOW);
    seedShop(db, TEST_NOW);
    const user = createUser(
      db,
      { email: 'unread@shop.test', password: 'a-good-password', name: 'Unread Tester' },
      TEST_NOW,
    );
    const order = checkout(db, user.customerId, [{ productId: 'PRD-MUG-01', quantity: 1 }], TEST_NOW);

    const broken: PipelineDeps = {
      analyzer: {
        ...FakeAnalyzer({ kind: 'unavailable', message: '503 from the provider' }),
        label: 'broken (test)',
      },
      recordAttempt: () => {},
      injectionAction: 'deny',
      discretion: DEFAULT_DISCRETION,
      notifyCustomer: () => {},
    };

    const result = await processRefundRequest(db, broken, {
      requestId: 'REQ-UNREAD',
      customerId: user.customerId,
      orderId: order.id,
      message: 'The mug arrived broken and I would like a refund',
      itemIds: [],
      now: TEST_NOW,
    });

    expect(result.stage).toBe('decided');
    if (result.stage === 'decided') {
      // Escalated, as it always was - but the customer is now told *why* the answer
      // looks like this, instead of receiving a notice indistinguishable from a
      // policy escalation.
      expect(result.decision.decision).toBe('escalated');
      expect(result.notice).toContain('could not read your message');
      expect(result.extraction).toBeNull();
    }
    db.close();
  });
});