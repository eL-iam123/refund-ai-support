import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnv } from '../config/env.js';

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

const KEYS = ['API_PORT', 'AI_PROVIDER', 'GROQ_API_KEY', 'ADMIN_API_SECRET', 'LOG_LEVEL'] as const;

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

  it('names the missing provider key rather than failing on a request', () => {
    for (const key of KEYS) {
      delete process.env[key];
    }
    process.env.ADMIN_API_SECRET = 'from-the-environment-32-characters-long';
    writeFileSync(envFile, 'API_PORT=4000\nAI_PROVIDER=groq\n');

    expect(() => readEnv(envFile)).toThrow(/GROQ_API_KEY/);
  });
});
