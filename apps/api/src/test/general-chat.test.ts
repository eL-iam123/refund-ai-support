import { describe, expect, it } from 'vitest';
import { isSafeGeneralReply } from '../ai/replyGuard.js';
import { inferTone } from '../response/tone.js';
import type { DialogueLine } from '../ai/analyzer.js';

/**
 * The conversational contract, both halves.
 *
 * The guard decides what model prose may reach a customer; tone decides how
 * the deterministic and prompted words sound. Both are pure functions of
 * their inputs, so both are pinned here rather than through HTTP.
 */
describe('isSafeGeneralReply', () => {
  const safe: readonly string[] = [
    'Hi! We sell lamps, mugs and kettles. Anything catch your eye?',
    'Our return policy allows returns within 45 days of delivery.',
    'Exchanges are possible for non-final-sale items - tell me what you have in mind.',
    'We ship to most countries; delivery times vary by destination.',
  ];
  for (const text of safe) {
    it(`allows "${text.slice(0, 40)}..."`, () => {
      expect(isSafeGeneralReply(text)).toBe(true);
    });
  }

  const unsafe: readonly [string, string][] = [
    ['outcome verb', 'Your refund has been approved!'],
    ['denial', 'Your claim was denied under R-02.'],
    ['escalation', 'This has been escalated to a person.'],
    ['figure', 'You will get $24.00 back.'],
    ['figure words', 'The amount is 2400 cents.'],
    ['first-person promise', 'We will refund you tomorrow.'],
    ['their case', 'Your return is on its way.'],
    ['order fact', 'Your order shipped yesterday and arrives Tuesday.'],
    ['tracking', 'Your tracking number is 1Z999.'],
    ['account access', 'I checked your account and found the order.'],
    ['empty', '   '],
  ];
  for (const [name, text] of unsafe) {
    it(`rejects ${name}`, () => {
      expect(isSafeGeneralReply(text)).toBe(false);
    });
  }
});

describe('inferTone', () => {
  function lines(...texts: string[]): readonly DialogueLine[] {
    return texts.map((text) => ({ role: 'customer' as const, text }));
  }

  it('greets a cold thread warmly', () => {
    expect(inferTone([])).toEqual({ tone: 'friendly' });
  });

  it('stays concise for terse threads', () => {
    expect(inferTone(lines('mug?', 'ok', 'price?'))).toEqual({ tone: 'concise' });
  });

  it('warms up on courtesy', () => {
    expect(inferTone(lines('Hello! Do you sell kettles, please?', 'Thanks!'))).toEqual({ tone: 'friendly' });
  });

  it('explains fully for detailed threads', () => {
    expect(
      inferTone(
        lines(
          'I am looking for a birthday gift for my father who loves pour-over coffee and already owns a grinder and a scale, so I need something substantial to complete his setup within a reasonable budget this year',
          'He prefers copper finishes and stovetop gear over anything electric, and durability matters far more than extra features or well-known brand names to him',
        ),
      ),
    ).toEqual({ tone: 'detailed' });
  });

  it('only reads customer turns and only the recent ones', () => {
    const filler = Array.from({ length: 10 }, () => 'x'.repeat(200));
    const recent = ['ok', 'mug?', 'blue?', 'price?', 'stock?', 'ship?'];
    // Without the six-turn window the long filler would dominate the average.
    expect(inferTone([...lines(...filler), ...lines(...recent)])).toEqual({ tone: 'concise' });
    // Assistant prose never sets the tone, however long.
    const thread: readonly DialogueLine[] = [
      { role: 'assistant', text: 'x'.repeat(500) },
      { role: 'customer', text: 'ok' },
    ];
    expect(inferTone(thread)).toEqual({ tone: 'concise' });
  });
});
