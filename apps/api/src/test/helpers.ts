import type { Db } from '../db/connection.js';
import type { FastifyInstance } from 'fastify';
import { openMemoryDatabase } from '../db/connection.js';
import { createAttemptRecorder } from '../db/attemptRecorder.js';
import { seedDatabase } from '../db/seed.js';
import { readEnv, type Env } from '../config/env.js';
import type { AIAnalyzer, ProviderAttempt } from '../ai/analyzer.js';
import type { PipelineDeps, ProcessResult } from '../orchestrator.js';
import { processRefundRequest } from '../orchestrator.js';
import { SCENARIOS, type InjectionAction, type Scenario } from '@refund/shared';
import { mintToken } from '../auth/tokens.js';
import { FakeAnalyzer, type Behaviour } from './fakeAnalyzer.js';
import { buildApp } from '../http/app.js';
import { silentLogger } from '../lib/logger.js';

/** Shared test fixtures. Every test builds its own in-memory database. */

export const TEST_NOW = new Date('2026-03-14T12:00:00.000Z');

/** The secret the harness builds apps with, and the one tokens are signed with. */
export const TEST_SECRET = 'test-secret-not-used-anywhere-32-chars-min';

/** The console credentials the harness configures, so the staff routes exist. */
export const TEST_ADMIN_USERNAME = 'test-admin';
export const TEST_ADMIN_PASSWORD = 'test-admin-password-not-real';

/** A valid Authorization header for a given role. */
export function authHeader(role: 'agent' | 'admin', subject = 'test-staff'): string {
  return `Bearer ${mintToken(TEST_SECRET, subject, role, 3_600_000, TEST_NOW)}`;
}

/** Looks a scenario up, failing the test rather than returning null. */
export function scenario(id: string): Scenario {
  const found = SCENARIOS.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no scenario with id "${id}"`);
  }
  return found;
}

/**
 * The real environment schema, with a placeholder key.
 *
 * `readEnv` is called with a path that does not exist so the ambient environment
 * and the repository's own `.env` cannot decide what a test sees. The key is a
 * placeholder that nothing ever sends: every test injects a fake analyzer or
 * stubs `fetch`, so nothing reaches the network. Using the production schema
 * rather than a test-only object means the tests exercise the same validation
 * and the same provider configuration the server does.
 */
export function testEnv(overrides: Partial<Env> = {}): Env {
  const keys = ['NODE_ENV', 'AI_PROVIDER', 'GROQ_API_KEY', 'LOG_LEVEL'] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);

  try {
    process.env.NODE_ENV = 'test';
    process.env.AI_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = 'test-key-not-used';
    process.env.LOG_LEVEL = 'silent';
    return {
      ...readEnv('.env.test-absent'),
      ADMIN_API_SECRET: TEST_SECRET,
      // The console is configured in the harness. `adminEnabled` gates every
      // staff route on these two, so without them the whole authorization suite
      // would be testing 404s and pass for the wrong reason.
      ADMIN_USERNAME: TEST_ADMIN_USERNAME,
      ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
      ...overrides,
    };
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export interface RecordedCall {
  readonly requestId: string;
  readonly provider: string;
  readonly attempt: ProviderAttempt;
}

export interface PipelineHarness extends PipelineDeps {
  readonly db: Db;
  readonly now: Date;
  readonly calls: RecordedCall[];
  /** How many times the analyzer was asked, successful or not. */
  readonly analyzerCalls: () => number;
  readonly run: (input: {
    requestId?: string;
    customerId: string;
    orderId?: string | null;
    message: string;
  }) => Promise<ProcessResult>;
}

/**
 * A seeded database wired to a fake analyzer, plus a one-call `run` helper.
 *
 * Everything downstream of the analyzer - grounding, the reason rules, the
 * resolver, persistence - is the production code path.
 */
export function scenarioHarness(
  behaviour: Behaviour = { kind: 'heuristic' },
  injectionAction: InjectionAction = 'deny',
): PipelineHarness {
  const db = openMemoryDatabase();
  seedDatabase(db, TEST_NOW);
  const calls: RecordedCall[] = [];
  const analyzer: AIAnalyzer = FakeAnalyzer(behaviour);

  const deps: PipelineDeps = {
    analyzer,
    injectionAction,
    recordAttempt: (requestId, provider, attempt) => {
      calls.push({ requestId, provider, attempt });
    },
  };

  return {
    ...deps,
    db,
    now: TEST_NOW,
    calls,
    analyzerCalls: () => calls.length,
    run: (input) =>
      processRefundRequest(db, deps, {
        requestId: input.requestId ?? 'REQ-TEST',
        customerId: input.customerId,
        orderId: input.orderId ?? null,
        message: input.message,
        now: TEST_NOW,
      }),
  };
}

export interface AppHarness {
  readonly app: FastifyInstance;
  readonly db: Db;
}

/**
 * A real Fastify app over a seeded in-memory database and a fake analyzer.
 *
 * `app.inject` exercises the full stack - routing, schema validation, the error
 * handler and the database - without binding a port. The fake is threaded in
 * through the context, so no test has to reach into module state.
 *
 * Note what is *not* faked: the database is the real in-memory one, the
 * recorder is the real one, and the pipeline is the production pipeline. Only
 * the model is replaced.
 */
export async function appHarness(
  behaviour: Behaviour = { kind: 'heuristic' },
  env: Env = testEnv(),
): Promise<AppHarness> {
  const db = openMemoryDatabase();
  seedDatabase(db, TEST_NOW);
  const app = buildApp({
    env,
    db,
    logger: silentLogger,
    // The same fixed "now" the fixtures were seeded against: otherwise the
    // 45-day refund window would read every order as months old.
    now: (): Date => TEST_NOW,
    pipeline: {
      analyzer: FakeAnalyzer(behaviour),
      recordAttempt: createAttemptRecorder(db),
      injectionAction: env.INJECTION_ACTION,
    },
  });
  await app.ready();
  return { app, db };
}

/**
 * Narrows a pipeline result to the branch that ended in a decision.
 *
 * The pipeline's result is a `stage` union on purpose - a clarifying question is
 * a real possible outcome now - but the policy tests are conformance claims that
 * a given input *must* decide. Asking each of them to re-narrow by hand would
 * spread "did this decide?" logic everywhere; this helper states it once, at the
 * same place the fixture's expected outcome is enforced.
 */
export function decided(
  result: ProcessResult,
): Extract<ProcessResult, { stage: 'decided' }> {
  if (result.stage === 'asked') {
    throw new Error(`expected a decision but the pipeline asked: ${result.question}`);
  }
  return result;
}
