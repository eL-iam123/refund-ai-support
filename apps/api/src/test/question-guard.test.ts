import { describe, expect, it } from 'vitest';
import { assistantLines, refineQuestion } from '../response/questionGuard.js';

/**
 * The deterministic floor under the messenger's questions.
 *
 * The prompt tells the model how to ask; the guard decides which asks are
 * actually allowed through. The two habits that make a small model read as a
 * script - a canned opening, and a demand for an order number the pipeline has
 * already resolved - are replaced with a warm restatement, and a question asked
 * for a second time hands the thread to a person instead of letting the loop
 * bounce forever.
 */
describe('the question guard', () => {
  const noHistory: readonly string[] = [];

  it('lets a genuine clarifying question through verbatim', () => {
    const refined = refineQuestion('Which item arrived damaged - the mug or the lamp?', {
      orderResolved: true,
      priorAssistantText: noHistory,
    });
    expect(refined.kind).toBe('publish');
    if (refined.kind === 'publish') {
      expect(refined.question).toBe('Which item arrived damaged - the mug or the lamp?');
    }
  });

  it('replaces a canned greeting with a warm restatement', () => {
    const refined = refineQuestion('Hello! How can I help you today?', {
      orderResolved: true,
      priorAssistantText: noHistory,
    });
    expect(refined.kind).toBe('replace');
    if (refined.kind === 'replace') {
      expect(refined.question).toContain('what happened with the order');
    }
  });

  it('replaces an order-number demand when the order is already resolved', () => {
    const refined = refineQuestion('Please provide your order number or let me know what you need.', {
      orderResolved: true,
      priorAssistantText: noHistory,
    });
    expect(refined.kind).toBe('replace');
  });

  it('does not assume an order when none was resolved', () => {
    // Without a resolved order, a question about how to find the right order is
    // a legitimate one and stays.
    const refined = refineQuestion("Could you tell me which order that is about?", {
      orderResolved: false,
      priorAssistantText: noHistory,
    });
    expect(refined.kind).toBe('publish');
  });

  it('escalates a question that repeats one already asked', () => {
    const asked = 'Which item arrived damaged - the mug or the lamp?';
    const refined = refineQuestion(asked, {
      orderResolved: true,
      priorAssistantText: ['Just to be sure - which item arrived damaged?', asked],
    });
    expect(refined.kind).toBe('escalate');
  });

  it('does not treat a differently-phrased question as a repeat', () => {
    const refined = refineQuestion('And which item was it that arrived damaged?', {
      orderResolved: true,
      priorAssistantText: ['Which item arrived damaged - the mug or the lamp?'],
    });
    expect(refined.kind).toBe('publish');
  });

  it('collects the assistant side of a transcript for the repeat check', () => {
    const lines = assistantLines([
      { role: 'customer', text: 'The mug is cracked.' },
      { role: 'assistant', text: 'Which part arrived damaged?' },
      { role: 'customer', text: 'The handle.' },
      { role: 'assistant', text: 'And the box is in your hands now?' },
    ]);
    expect(lines).toEqual(['Which part arrived damaged?', 'And the box is in your hands now?']);
  });
});