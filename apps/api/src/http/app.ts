import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import { existsSync } from 'node:fs';
import { corsOrigins, adminEnabled, type Env } from '../config/env.js';
import { createLogger, type Logger } from '../lib/logger.js';
import type { Db } from '../db/connection.js';
import { aiModeLabel, buildContext } from './context.js';
import type { PipelineDeps } from '../orchestrator.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerRequestRoutes } from './routes/requests.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerShopRoutes } from './routes/shop.js';
import { registerRefundRoutes } from './routes/refunds.js';
import { registerReturnsRoutes } from './routes/returns.js';
import { registerAdminAuthRoutes } from './routes/adminAuth.js';
import { toErrorResponse, toHttpError } from './errors.js';
import { registerAuth } from '../auth/guards.js';

export interface BuildAppOptions {
  readonly env: Env;
  readonly db: Db;
  /** Overridden in tests so vitest output stays readable. */
  readonly logger?: Logger;
  /** Directory holding the built client, served at `/` when present. */
  readonly staticDir?: string;
  /** Injected so tests share the scenario fixtures' fixed "now". */
  readonly now?: () => Date;
  /**
   * Replaces the model boundary. Tests pass a fake analyzer here; production
   * never sets it, so the server always builds the provider the environment
   * names.
   */
  readonly pipeline?: PipelineDeps;
}

/**
 * Builds the HTTP server.
 *
 * Takes its dependencies rather than creating them, so the test suite boots a
 * real app against an in-memory database and a fake analyzer with no globals
 * and no module mocking.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const log = options.logger ?? createLogger(options.env.LOG_LEVEL);
  const now = options.now ?? ((): Date => new Date());
  const ctx = buildContext(options.env, options.db, log, now, { pipeline: options.pipeline });

  const app = Fastify({
    // pino is disabled: our Logger interface is the logging contract, and the
    // seed CLI and tests need the same one the server uses.
    logger: false,
    bodyLimit: 64 * 1024,
  });

  // Cookie parsing backs the storefront session. Registered before the routes
  // that read `request.cookies`.
  void app.register(cookie);

  void app.register(cors, {
    origin: corsOrigins(options.env),
    credentials: false,
  });

  registerAuth(app);

  void app.register(rateLimit, {
    max: options.env.RATE_LIMIT_MAX,
    timeWindow: options.env.RATE_LIMIT_WINDOW,
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = toHttpError(error);
    if (mapped.statusCode >= 500) {
      ctx.log.error({ err: error, url: request.url }, 'request.failed');
    }
    return reply.code(mapped.statusCode).send(toErrorResponse(mapped));
  });

  app.get('/api/health', () => ({
    status: 'ok',
    aiMode: aiModeLabel(ctx.pipeline),
    // Published so the client can decide whether to render a staff console that
    // exists. It reveals nothing but the shape of the deployment: whether an
    // operator account is configured is a fact about a demo, not a secret, and
    // the staff routes themselves still answer 404 without a credential.
    adminEnabled: adminEnabled(options.env),
  }));

  registerChatRoutes(app, ctx);
  registerRequestRoutes(app, ctx);
  registerCatalogRoutes(app, ctx);
  registerShopRoutes(app, ctx);
  registerRefundRoutes(app, ctx);
  registerReturnsRoutes(app, ctx);
  // Unconditional, because a sign-in route that vanished on an unconfigured
  // deployment would leave the client unable to tell "disabled" from "wrong
  // path". It answers 404 itself when the console is not configured.
  registerAdminAuthRoutes(app, ctx);

  registerNotFound(app, options.staticDir);
  return app;
}

/**
 * Installs the 404 handler unconditionally so the error envelope is the same
 * whether or not the static client is mounted. Only the HTML fallback is
 * conditional: without a built client there is nothing to fall back to, and
 * a browser hitting a missing route should see JSON rather than a bare 404.
 */
function registerNotFound(app: FastifyInstance, staticDir: string | undefined): void {
  // One client, one origin. The storefront and the assistant are the same bundle
  // behind the same topbar, so the session cookie that ties an order to a refund
  // is first-party and there is no second deployment to keep in step.
  if (staticDir !== undefined && existsSync(staticDir)) {
    void app.register(fastifyStatic, { root: staticDir, wildcard: false });
    app.log.info({ staticDir }, 'static.serving');
  }

  const hasClient = staticDir !== undefined && existsSync(staticDir);

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found', message: `no route for ${request.url}` });
    }
    if (hasClient) {
      // Client-side routing: any non-API path is the app's own index.html.
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: `no route for ${request.url}` });
  });
}
