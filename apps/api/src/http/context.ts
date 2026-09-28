import type { Db } from '../db/connection.js';
import { createAttemptRecorder } from '../db/attemptRecorder.js';
import type { Env } from '../config/env.js';
import { createAnalyzer } from '../ai/index.js';
import type { PipelineDeps } from '../orchestrator.js';
import type { Logger } from '../lib/logger.js';

/**
 * The request-scoped dependencies, built once at boot.
 *
 * `db` and `pipeline` are the only mutable state in the whole server;
 * everything else is a pure function. Handing the route handlers this object
 * rather than importing singletons is what lets the test suite boot a real app
 * against an in-memory database and a fake analyzer, without monkey-patching
 * anything.
 *
 * `now` is a function rather than a value because order age drives the refund
 * window: a request handled at 23:59 and the same request handled at 00:01
 * are different policy questions. Injecting the clock keeps that boundary
 * explicit and lets the HTTP tests assert against the same fixed "now" the
 * scenario fixtures are built from.
 */
export interface AppContext {
  readonly env: Env;
  readonly db: Db;
  readonly pipeline: PipelineDeps;
  readonly log: Logger;
  readonly now: () => Date;
}

export function buildContext(
  env: Env,
  db: Db,
  log: Logger,
  now: () => Date,
  overrides: ContextOverrides = {},
): AppContext {
  return {
    env,
    db,
    pipeline:
      overrides.pipeline ?? {
        analyzer: createAnalyzer(env),
        recordAttempt: createAttemptRecorder(db),
        injectionAction: env.INJECTION_ACTION,
      },
    log,
    now,
  };
}

/**
 * The one thing tests replace: the analyzer that talks to a model.
 *
 * Overriding the whole `PipelineDeps` pair rather than only the analyzer keeps
 * the recorder honest too - a test that asserts on persisted attempts needs a
 * sink it can inspect, not the production database write.
 */
export interface ContextOverrides {
  readonly pipeline?: PipelineDeps | undefined;
}

/** The label the admin surfaces show for "which model is this". */
export function aiModeLabel(pipeline: PipelineDeps): string {
  return `${pipeline.analyzer.label} (${pipeline.analyzer.model})`;
}
