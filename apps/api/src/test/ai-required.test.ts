import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEnv } from '../config/env.js';

/**
 * The boot guarantee for a process that is required to have a model.
 *
 * This is the piece that makes "the AI is on" a fact rather than a hope. The
 * default mode - boot without a key, escalate everything to a person - is
 * genuinely good behaviour. What it cannot catch is the failure nobody notices:
 * a deployment paying for a model it never reaches, serving traffic that all
 * escalates, with a dashboard that looks healthy. `AI_REQUIRED` is the switch
 * that turns that into a failed boot, so it is tested as the load-bearing thing
 * it is.
 *
 * The messages are asserted as well as the throw. A boot failure is read once, in
 * a terminal, by someone who has never seen this codebase: "NVIDIA_API_KEY is
 * not set" alone leaves them hunting for where to set it.
 *
 * Configuration is set through `process.env` and read with a path that does not
 * exist, because `readEnv` loads a file and gives the real environment priority.
 * Pointing it at a real `.env` would silently import whatever key the developer
 * running the suite happens to have, and these tests would pass or fail depending
 * on whose laptop they are on.
 */

const KEYS = [
  'NODE_ENV',
  'AI_PROVIDER',
  'AI_REQUIRED',
  'AI_MODEL',
  'AI_FALLBACK_MODELS',
  'AI_BASE_URL',
  'ADMIN_API_SECRET',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'NVIDIA_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

/** Never resolves, so a test cannot accidentally read a developer's own .env. */
const NO_FILE = '/nonexistent/.env-for-tests';

let saved: Map<string, string | undefined>;

beforeEach(() => {
  saved = new Map(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    delete process.env[key];
  }
  process.env.NODE_ENV = 'production';
  process.env.AI_PROVIDER = 'nvidia';
  process.env.AI_REQUIRED = 'true';
  process.env.ADMIN_API_SECRET = 'a-secret-that-is-not-the-placeholder';
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('a process that requires a model refuses to start without one', () => {
  it('refuses when the key is missing, and names the variable', () => {
    expect(() => readEnv(NO_FILE)).toThrow(/NVIDIA_API_KEY is not set/);
  });

  it('refuses when the key belongs to a provider that is not selected', () => {
    // The mistake worth catching: a key *is* present, so the operator reasonably
    // assumes it is in use, while the config points somewhere else and every
    // request quietly escalates.
    process.env.GROQ_API_KEY = 'gsk-something';
    expect(() => readEnv(NO_FILE)).toThrow(/NVIDIA_API_KEY is not set/);
  });

  it('treats an empty key as absent, not as a key', () => {
    // `NVIDIA_API_KEY=` left in a .env is the most common way this goes wrong,
    // and the dangerous version is the one that looks configured.
    process.env.NVIDIA_API_KEY = '';
    expect(() => readEnv(NO_FILE)).toThrow(/NVIDIA_API_KEY is not set/);
  });

  it('says where to fix it, not only what is wrong', () => {
    expect(() => readEnv(NO_FILE)).toThrow(/\.env/);
  });

  it('refuses `local` by name, rather than complaining about a key', () => {
    // `local` has no key variable at all, so checking for a missing key first
    // would produce a confusing error about a variable that does not exist.
    process.env.AI_PROVIDER = 'local';
    expect(() => readEnv(NO_FILE)).toThrow(/pattern matcher/);
  });

  it('treats an empty AI_REQUIRED as unset, not as invalid', () => {
    // Docker Compose always sets every declared variable, so an unset one arrives
    // as an empty string rather than as an absent variable. Without this the
    // switch breaks the one command it exists to keep working - and it breaks it
    // as a crash loop, because the container never comes up far enough to log
    // anything useful. The same reasoning as EMPTY_IS_ABSENT for the keys.
    process.env.NODE_ENV = 'development';
    process.env.AI_REQUIRED = '';
    expect(readEnv(NO_FILE).AI_PROVIDER).toBe('nvidia');
  });

  it('starts when the selected provider has its key', () => {
    process.env.NVIDIA_API_KEY = 'nvapi-real-looking-key';
    expect(readEnv(NO_FILE).AI_PROVIDER).toBe('nvidia');
  });
});

describe('the default mode still degrades instead of failing', () => {
  it('tolerates a missing key in development when AI_REQUIRED is unset', () => {
    // The deliberate behaviour: a reviewer who clones this and runs
    // `docker compose up` gets a working product, and requests escalate rather
    // than being guessed at. Refusing to start would leave them with nothing to
    // evaluate, which is worse than an honest degraded one.
    process.env.NODE_ENV = 'development';
    delete process.env.AI_REQUIRED;
    expect(readEnv(NO_FILE).AI_PROVIDER).toBe('nvidia');
  });

  it('treats production as required even when AI_REQUIRED is unset', () => {
    // A deployment that is supposed to *be* the model should not have to opt in
    // to the guarantee. Opting out should be the deliberate act.
    delete process.env.AI_REQUIRED;
    expect(() => readEnv(NO_FILE)).toThrow(/NVIDIA_API_KEY is not set/);
  });

  it('lets a deployment opt back out explicitly', () => {
    // The escape hatch, and it is explicit. A run that genuinely wants to queue
    // everything for a person has to say so, in writing, in its configuration.
    process.env.AI_REQUIRED = 'false';
    expect(readEnv(NO_FILE).AI_PROVIDER).toBe('nvidia');
  });

  it('does not let opting out re-enable the pattern matcher in production', () => {
    // Two separate guarantees, and only one of them is negotiable. `AI_REQUIRED`
    // governs the missing *key*; the refusal of `local` in production is
    // absolute, because a pattern matcher is not a degraded model - it is a
    // different system that answers with the same confidence. `AI_REQUIRED=false`
    // means "escalate instead of reading", never "guess and present it as read".
    process.env.AI_REQUIRED = 'false';
    process.env.AI_PROVIDER = 'local';
    expect(() => readEnv(NO_FILE)).toThrow(/pattern matcher/);
  });
});
