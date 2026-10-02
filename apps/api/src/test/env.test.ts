import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingApiKeyFor, readEnv, PLACEHOLDER_SECRET } from '../config/env.js';

/**
 * Where configuration comes from, and in what order.
 *
 * The file provides defaults and the real environment wins. That ordering is the
 * one operators assume, and getting it backwards is a deployment bug that looks
 * like the service ignoring its configuration: `docker run -e API_PORT=8080`
 * would bind the port baked into `.env` instead, and nothing in the logs would
 * say so. Node's `loadEnvFile` overwrites existing variables, so the precedence
 * has to be restored deliberately.
 */

const KEYS = ['API_PORT', 'AI_PROVIDER', 'GROQ_API_KEY', 'ADMIN_API_SECRET', 'LOG_LEVEL', 'NODE_ENV', 'RATE_LIMIT_MAX'] as const;

describe('environment precedence', () => {
  let saved: Map<string, string | undefined>;
  let envFile: string;

  beforeEach(() => {
    saved = new Map(KEYS.map((key) => [key, process.env[key]]));
    const dir = mkdtempSync(join(tmpdir(), 'env-precedence-'));
    envFile = join(dir, '.env');
    writeFileSync(
      envFile,
      [
        'API_PORT=4000',
        'AI_PROVIDER=groq',
        'GROQ_API_KEY=from-the-file',
        'ADMIN_API_SECRET=file-secret-value-32-characters-long',
        'LOG_LEVEL=info',
        '',
      ].join('\n'),
    );
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

  it('uses the file when nothing is set in the environment', () => {
    for (const key of KEYS) {
      delete process.env[key];
    }

    const env = readEnv(envFile);

    expect(env.API_PORT).toBe(4000);
    expect(env.GROQ_API_KEY).toBe('from-the-file');
    expect(env.RATE_LIMIT_MAX).toBe(300);
  });

  it('keeps the lower rate-limit default outside development and honors explicit values', () => {
    for (const key of KEYS) {
      delete process.env[key];
    }
    process.env.NODE_ENV = 'test';
    expect(readEnv(envFile).RATE_LIMIT_MAX).toBe(30);

    process.env.NODE_ENV = 'development';
    process.env.RATE_LIMIT_MAX = '42';
    expect(readEnv(envFile).RATE_LIMIT_MAX).toBe(42);
  });

  it('lets a real environment variable override the file', () => {
    // The regression: Node's loader overwrites what is already set, so this
    // assertion is the whole point of the test.
    process.env.API_PORT = '8080';

    expect(readEnv(envFile).API_PORT).toBe(8080);
  });

  it('accepts a secret that only the environment has', () => {
    // Docker injects the secret and ships no `.env`, so a file that omits it must
    // not clear it out of the environment.
    process.env.ADMIN_API_SECRET = 'from-the-environment-32-characters-long';
    writeFileSync(envFile, 'API_PORT=4000\nAI_PROVIDER=groq\nGROQ_API_KEY=k\n');

    expect(readEnv(envFile).ADMIN_API_SECRET).toBe('from-the-environment-32-characters-long');
  });

  it('boots without a provider key rather than refusing to start', () => {
    // A key that is simply absent is not a misconfiguration to reject, it is a
    // product with no model. Refusing to start leaves an operator with a dead
    // service and no queue; the alternative is to run and let every request that
    // needs a claim escalate, which is the only outcome a missing model is
    // allowed to produce.
    for (const key of KEYS) {
      delete process.env[key];
    }
    process.env.ADMIN_API_SECRET = 'from-the-environment-32-characters-long';
    writeFileSync(envFile, 'API_PORT=4000\nAI_PROVIDER=groq\n');

    const env = readEnv(envFile);

    expect(env.AI_PROVIDER).toBe('groq');
    expect(missingApiKeyFor(env)).toBe('AI_API_KEY is not set, so groq cannot be reached');
  });

  it('reports no missing key when the provider is configured', () => {
    for (const key of KEYS) {
      delete process.env[key];
    }
    process.env.ADMIN_API_SECRET = 'from-the-environment-32-characters-long';

    expect(missingApiKeyFor(readEnv(envFile))).toBeNull();
  });
});

describe('AI_PROVIDER=local', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function fileWith(overrides: Record<string, string>): string {
    const path = join(tmpdir(), `local-${Math.random().toString(36).slice(2)}.env`);
    writeFileSync(
      path,
      Object.entries({ ADMIN_API_SECRET: 'a'.repeat(48), AI_PROVIDER: 'local', ...overrides })
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    return path;
  }

  it('needs no key, because it calls nothing', () => {
    delete process.env.NODE_ENV;
    const env = readEnv(fileWith({}));

    expect(env.AI_PROVIDER).toBe('local');
    expect(missingApiKeyFor(env)).toBeNull();
  });

  it('is refused in production, where a pattern matcher is not a model', () => {
    // The distinction that matters: an absent key degrades to *no claims*, which
    // is safe. `local` produces claims from regular expressions, which look like
    // a model read the message and are not, so it must never be the answer in a
    // deployment.
    delete process.env.NODE_ENV;
    expect(() => readEnv(fileWith({ NODE_ENV: 'production' }))).toThrow(/pattern matcher/);
  });
});

describe('the bundled placeholder secret', () => {
  /** Writes a minimal .env so the check runs against a real file, as in Docker. */
  function envFileWith(extra: Record<string, string>): string {
    const path = join(tmpdir(), `placeholder-${Math.random().toString(36).slice(2)}.env`);
    const body = Object.entries({
      // A provider the production guard accepts, so these tests fail on the
      // secret they are about rather than on an unrelated "local is not a model"
      // refusal triggered by the new no-key default.
      AI_PROVIDER: 'nvidia',
      NVIDIA_API_KEY: 'nvapi-test-key',
      ADMIN_API_SECRET: PLACEHOLDER_SECRET,
      ...extra,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    writeFileSync(path, body);
    return path;
  }

  const saved = { ...process.env };
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // Vitest runs with NODE_ENV=test, and readEnv restores what the process
  // already had over whatever the file said. Without this the file's
  // NODE_ENV=production is silently overwritten and the check never runs.
  function withCleanEnv(): void {
    delete process.env.NODE_ENV;
    delete process.env.ADMIN_API_SECRET;
  }

  it('refuses to start a production container with the published placeholder', () => {
    // docker-compose.yml carries this value so `docker compose up` is a single
    // command. In production it is a secret that is in the repository, so the
    // stack must stop rather than mint admin tokens anyone can forge.
    withCleanEnv();
    const file = envFileWith({ NODE_ENV: 'production' });

    expect(() => readEnv(file)).toThrow(/still the bundled placeholder/);
  });

  it('accepts a real secret in production', () => {
    withCleanEnv();
    const file = envFileWith({ NODE_ENV: 'production', ADMIN_API_SECRET: 'a'.repeat(48) });

    expect(() => readEnv(file)).not.toThrow();
  });

  it('allows the placeholder outside production, so the one-command demo works', () => {
    withCleanEnv();
    const file = envFileWith({ NODE_ENV: 'development' });

    expect(() => readEnv(file)).not.toThrow();
  });

  it('still refuses a short secret in development', () => {
    withCleanEnv();
    const file = envFileWith({ NODE_ENV: 'development', ADMIN_API_SECRET: 'too-short' });

    expect(() => readEnv(file)).toThrow(/32 characters/);
  });
});

describe('variables compose passes as empty strings', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('treats an empty optional as absent rather than as a value', () => {
    // `docker compose` forwards every unset variable as ''. The schema used to
    // fail on those first, so a machine with no .env at all was told
    // "AI_MODEL: Too small" when the real answer was simply "no key configured".
    for (const key of ['NODE_ENV', 'ADMIN_API_SECRET', 'GROQ_API_KEY', 'AI_PROVIDER']) {
      delete process.env[key];
    }
    process.env.AI_MODEL = '';
    process.env.AI_BASE_URL = '';
    process.env.ADMIN_API_SECRET = 'a'.repeat(48);
    process.env.AI_PROVIDER = 'groq';

    const env = readEnv('/nonexistent-for-this-test');

    expect(env.AI_MODEL).toBeUndefined();
    expect(env.AI_BASE_URL).toBeUndefined();
  });

  it('treats an empty key as absent, not as a usable one', () => {
    // The distinction that was being lost: `GROQ_API_KEY=''` is not a key that
    // works, it is a key that is not there, and the analyzer must be built the
    // same way for both.
    for (const key of [
      'NODE_ENV',
      'ADMIN_API_SECRET',
      'GROQ_API_KEY',
      'AI_API_KEY',
      'AI_PROVIDER',
      'AI_REQUIRED',
    ]) {
      delete process.env[key];
    }
    process.env.GROQ_API_KEY = '';
    process.env.AI_API_KEY = '';
    process.env.ADMIN_API_SECRET = 'a'.repeat(48);
    process.env.AI_PROVIDER = 'groq';

    expect(missingApiKeyFor(readEnv('/nonexistent-for-this-test'))).toBe(
      'AI_API_KEY is not set, so groq cannot be reached',
    );
  });
});
