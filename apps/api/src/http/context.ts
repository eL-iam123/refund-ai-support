import type { Db } from '../db/connection.js';
import { createAttemptRecorder } from '../db/attemptRecorder.js';
import type { Env } from '../config/env.js';
import { discretionConfig, itemPickerConfig } from '../config/env.js';
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
  /** Late-bound, so the pipeline can announce ladder progress once the hub exists. */
  readonly customerEvents: CustomerEvents;
}

/**
 * Where the pipeline announces things that happen *during* a request.
 *
 * Late-bound because the hub is created after this context, and the pipeline is
 * built inside it. A null notifier simply means no hub - a script, a seed run, a
 * test that does not care - and the pipeline carries on either way.
 */
export interface CustomerEvents {
  notify: ((customerId: string) => void) | null;
}

/**
 * The pipeline the app runs on.
 *
 * Extracted so the demo seed decides its claims through exactly this configuration
 * rather than a lookalike: a demo whose requests went down a differently-configured
 * path would not be evidence of anything.
 */
export function buildPipelineDeps(env: Env, db: Db, notifyCustomer?: (customerId: string) => void): PipelineDeps {
  return {
    analyzer: createAnalyzer(env),
    recordAttempt: createAttemptRecorder(db),
    injectionAction: env.INJECTION_ACTION,
    discretion: discretionConfig(env),
    itemPicker: itemPickerConfig(env),
    minConfidence: env.AI_MIN_CONFIDENCE,
    escalationCeilingCents: env.ESCALATION_CEILING_CENTS,
    // Optional on the dependency, so absent rather than undefined when there is no
    // socket to publish to.
    ...(notifyCustomer === undefined ? {} : { notifyCustomer }),
  };
}

export function buildContext(
  env: Env,
  db: Db,
  log: Logger,
  now: () => Date,
  overrides: ContextOverrides = {},
): AppContext {
  const customerEvents: CustomerEvents = { notify: null };
  const pipeline =
    overrides.pipeline ??
    buildPipelineDeps(env, db, (customerId: string): void => {
      customerEvents.notify?.(customerId);
    });

  return { env, db, pipeline, log, now, customerEvents };
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