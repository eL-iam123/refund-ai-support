import { describe, expect, it } from 'vitest';
import { inferTone } from '../response/tone.js';
import type { DialogueLine } from '../ai/analyzer.js';

/**
 * Tone, as a pure function of the thread.
 *
 * How the deterministic and prompted words sound: brief or warm, from the
 * customer's own turns. Pinned here rather than through HTTP.
 */
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