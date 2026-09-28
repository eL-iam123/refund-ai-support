/**
 * Issues a staff token: `pnpm --filter @refund/api token --agent alice --role admin`
 *
 * Deliberately a CLI and not an HTTP route. A login endpoint here would need a
 * user store, a password policy and a session lifecycle, and a half-built
 * version of that is a weaker perimeter than no login at all - it looks like
 * authentication while remaining trivially bypassable. Staff credentials in this
 * system are provisioned out of band, which is what a real deployment behind an
 * identity provider would do anyway.
 */

import { readEnv } from '../config/env.js';
import { mintToken, ROLES, type Role } from './tokens.js';

interface Options {
  readonly agent: string;
  readonly role: Role;
  readonly ttlMs: number;
}

const TTL_PATTERN = /^(\d+)([smhd])$/;

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('usage: token --agent <id> [--role agent|admin] [--ttl 8h]');
    }
    values.set(key.slice(2), value);
  }

  const agent = values.get('agent');
  if (agent === undefined || agent.trim().length === 0) {
    throw new Error('--agent is required');
  }
  const role = (values.get('role') ?? 'agent') as Role;
  if (!ROLES.includes(role)) {
    throw new Error(`--role must be one of: ${ROLES.join(', ')}`);
  }
  return { agent: agent.trim(), role, ttlMs: parseTtl(values.get('ttl') ?? '8h') };
}

function parseTtl(raw: string): number {
  const match = TTL_PATTERN.exec(raw);
  const unit = match?.[2];
  const amount = match?.[1];
  if (match === null || unit === undefined || amount === undefined) {
    throw new Error('--ttl must look like 30m, 8h or 7d');
  }
  return Number(amount) * (UNITS[unit] ?? 0);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const env = readEnv();
  process.stdout.write(
    `${mintToken(env.ADMIN_API_SECRET, options.agent, options.role, options.ttlMs, new Date())}\n`,
  );
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
