import { describe, expect, it } from 'vitest';
import { buildIntakeUser, INTAKE_SYSTEM } from '../ai/prompts.js';
import type { AnalyzerOrder } from '../ai/analyzer.js';

/**
 * The ask rules the storefront's live assistant is judged on.
 *
 * The messenger loop works mechanically - a question is a dialogue turn, an
 * answer becomes the next context - so the quality of the conversation is
 * entirely decided by the prompt. These tests pin the rules that stop the
 * assistant reading back the customer's own order to them.
 */
describe('the agent prompt', () => {
  const ORDER: AnalyzerOrder = {
    id: 'ORD-1',
    totalCents: 4200,
    status: 'delivered',
    paymentState: 'captured',
    ageDays: 3,
    items: [{ id: 'MUG', name: 'Ceramic mug', quantity: 1, unitPriceCents: 4200 }],
  };

  it('forbids asking for an order number once the order block is present', () => {
    expect(INTAKE_SYSTEM).toContain('when an Order block is present above');
    expect(INTAKE_SYSTEM).toContain('ask the customer for an order number');
    expect(INTAKE_SYSTEM).toContain('Never repeat a question');
    expect(INTAKE_SYSTEM).toContain('do not insist');
  });

  it('demands a warm, human voice and no canned greetings', () => {
    expect(INTAKE_SYSTEM).toContain('Never open with a canned greeting');
    expect(INTAKE_SYSTEM).toContain('"Hello! How can I help you today?"');
    expect(INTAKE_SYSTEM).toContain('open by acknowledging it, in their own words');
    expect(INTAKE_SYSTEM).toContain('warm, plain and short');
  });

  it('requires the model to restate the complaint before asking', () => {
    expect(INTAKE_SYSTEM).toContain('Restate their problem in your own words');
    expect(INTAKE_SYSTEM).toContain("Just to be sure I've got it right");
    expect(INTAKE_SYSTEM).toContain('turns it into a case a person can pick up and resolve');
  });

  it('bounds the ask loop and guides the questions', () => {
    expect(INTAKE_SYSTEM).toContain('Only ask when the claim genuinely cannot be completed without a detail that is missing');
    expect(INTAKE_SYSTEM).toContain('Ask one short question at a time');
    expect(INTAKE_SYSTEM).toContain('Never ask "anything else?" filler');
    expect(INTAKE_SYSTEM).toContain('do not keep asking for a perfect picture');
  });

  it('tells the model the order is already identified when one was resolved', () => {
    const user = buildIntakeUser('The mug is cracked, I want a refund.', ORDER, [], true);
    expect(user).toContain('The order above has already been identified by the system.');
    expect(user).toContain('Do not ask the customer for it.');
  });

  it('does not claim an order is identified when none was resolved', () => {
    const user = buildIntakeUser('It arrived damaged.', null, [], true);
    expect(user).toContain('No order has been identified yet.');
    expect(user).not.toContain('has already been identified');
  });

  it('always shows the order total, even when the rest of the order is withheld', () => {
    const user = buildIntakeUser('The whole order is wrong.', ORDER, [], false);
    expect(user).toContain('ORD-1');
    expect(user).toContain('total $42.00');
    expect(user).toContain('Item details withheld at this stage.');
  });

  it('withholds item names and prices unless order facts are shared', () => {
    const withheld = buildIntakeUser('It is damaged.', ORDER, [], false);
    expect(withheld).not.toContain('Ceramic mug');

    const shared = buildIntakeUser('It is damaged.', ORDER, [], true);
    expect(shared).toContain('Ceramic mug');
    expect(shared).toContain('total $42.00');
  });
});