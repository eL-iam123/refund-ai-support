import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { appHarness, TEST_NOW, type AppHarness } from './helpers.js';
import { daysAgo } from '../db/seed.js';
import type { Db } from '../db/connection.js';
import { listRequests } from '../db/requestRepository.js';
import { listDialogueForOrder } from '../db/dialogue.js';
import { conversationForOrder } from '../retrieval/conversation.js';

/**
 * The messenger loop.
 *
 * The assistant's job is to ask before assuming. When a complaint spans more
 * than one of the customer's own orders, the pipeline must ask which one rather
 * than inventing a target - and when the customer answers, the decision must be
 * made against the context that asked. That arc has two halves, and both are
 * asserted here:
 *
 *  - The ask is a question, not a decision: HTTP 200, no `refund_requests`
 *    row, and the exchange stored as dialogue so a refresh keeps it.
 *  - The answer is a decision made with the question in context: the fake
 *    `ask` analyzer turns the customer's answer into a claim, the claim is
 *    grounded against the customer's *earlier* words (the message that started
 *    the loop), and the dialogue is adopted by the order it resolved to.
 */
const CUSTOMER = 'CUST-DLG';
const LAMP_ORDER = 'ORD-D1';
const MUG_ORDER = 'ORD-D2';
const HEADPHONE_ORDER = 'ORD-D3';

/** Three owned orders, so "which order?" is a real question with never an id given. */
function seedHistory(db: Db): void {
  db.prepare(
    `INSERT INTO customers (id, name, email, tier, account_created_at, prior_refund_count, refund_requests_last_30d)
     VALUES (?, 'Dialogue Buyer', 'dialogue.buyer@example.com', 'standard', ?, 0, 0)`,
  ).run(CUSTOMER, daysAgo(TEST_NOW, 400).toISOString());

  const insertOrder = db.prepare(
    `INSERT INTO orders (id, customer_id, placed_at, delivered_at, status, payment_state,
       refunded_cents, is_subscription, tracking_status, signed_by_customer, condition_at_delivery)
     VALUES (?, ?, ?, ?, 'delivered', 'captured', 0, 0, 'delivered', 1, 'good')`,
  );
  insertOrder.run(LAMP_ORDER, CUSTOMER, daysAgo(TEST_NOW, 8).toISOString(), daysAgo(TEST_NOW, 4).toISOString());
  insertOrder.run(MUG_ORDER, CUSTOMER, daysAgo(TEST_NOW, 30).toISOString(), daysAgo(TEST_NOW, 26).toISOString());
  // Inside the 45-day window so the resolved order is eligible to approve.
  insertOrder.run(HEADPHONE_ORDER, CUSTOMER, daysAgo(TEST_NOW, 20).toISOString(), daysAgo(TEST_NOW, 16).toISOString());

  const insertItem = db.prepare(
    `INSERT INTO order_items (id, order_id, name, unit_price_cents, quantity, final_sale, digital, downloaded)
     VALUES (?, ?, ?, ?, 1, 0, 0, 0)`,
  );
  insertItem.run('ITM-D1-A', LAMP_ORDER, 'Aria Floor Lamp', 30000);
  insertItem.run('ITM-D2-A', MUG_ORDER, 'Ceramic Mug Set', 10000);
  insertItem.run('ITM-D3-A', HEADPHONE_ORDER, 'Studio Headphones', 32000);
}

const QUESTION = 'Which of your orders is that about?';

describe('the ask-then-decide loop', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    // Not the heuristic analyzer: a real fake that asks exactly once, then
    // submits the claim once the customer has spoken again. The claim grounds on
    // the customer's *first* message, which only the dialogue context makes
    // possible - pinning the "the model may quote an earlier turn" contract.
    harness = await appHarness({
      kind: 'ask',
      question: QUESTION,
      then: {
        intent: 'refund',
        reason: 'damaged',
        condition: 'damaged',
        confidence: 0.9,
        orderRef: null,
        claimedAmountCents: null,
        items: ['ITM-D3-A'],
        evidenceQuotes: ['the headphones both arrived broken'],
        language: 'en',
        urgency: 'normal',
        policyOverrideAttempted: false,
      },
    });
    seedHistory(harness.db);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  function post(message: string): Promise<LightMyRequestResponse> {
    return harness.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      payload: { customerId: CUSTOMER, message },
    });
  }

  function requestCount(db: Db): number {
    return listRequests(db, { limit: 500 }).length;
  }

  it('asks which order when the complaint spans more than one owned order', async () => {
    const before = requestCount(harness.db);

    const response = await post('The floor lamp and the headphones both arrived broken.');

    // A question is a 200 with no request row: nothing was decided, and nothing
    // may be persisted as though it was.
    expect(response.statusCode).toBe(200);
    const body = response.json<{ question: string; dialogueId: string }>();
    expect(body.question).toBe(QUESTION);
    expect(body.dialogueId).toMatch(/^DLG-/);
    expect(requestCount(harness.db)).toBe(before);

    // The dialogue half is real storage, not a by-product of the reply: the turn
    // survives with its order unresolved, which is the only honest place for it.
    const dialogue = listDialogueForOrder(harness.db, CUSTOMER, HEADPHONE_ORDER, 20);
    expect(dialogue).toHaveLength(0);
  });

  it('decides the answer against the question that asked it', async () => {
    await post('The floor lamp and the headphones both arrived broken.');

    const response = await post("It's the headphones, they arrived broken.");

    expect(response.statusCode).toBe(201);
    const { request } = response.json<{ request: { orderId: string; decision: { decision: string; refundAmountCents: number }; grounding: { grounded: boolean; verifiedQuotes: readonly string[] } | null } }>();
    expect(request.orderId).toBe(HEADPHONE_ORDER);
    expect(request.decision.decision).toBe('approved');
    expect(request.decision.refundAmountCents).toBe(32000);

    // The claim quoted the customer's opening message, not the answer. Only the
    // transcript of the earlier turn could have grounded it.
    expect(request.grounding?.grounded).toBe(true);
    expect(request.grounding?.verifiedQuotes).toContain('the headphones both arrived broken');
  });

  it('adopts the ask into the order its answer resolved to', async () => {
    await post('The floor lamp and the headphones both arrived broken.');
    await post("It's the headphones, they arrived broken.");

    // The order's thread now reads as one conversation: the question that asked,
    // then the request it produced.
    const dialogue = listDialogueForOrder(harness.db, CUSTOMER, HEADPHONE_ORDER, 20);
    expect(dialogue).toHaveLength(1);
    expect(dialogue[0]?.customerMessage).toBe('The floor lamp and the headphones both arrived broken.');
    expect(dialogue[0]?.assistantQuestion).toBe(QUESTION);

    const thread = conversationForOrder(harness.db, CUSTOMER, HEADPHONE_ORDER, TEST_NOW, 20);
    expect(thread.map((turn) => turn.kind)).toEqual(['dialogue', 'request']);
  });
});