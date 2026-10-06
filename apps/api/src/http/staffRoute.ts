import type { FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { staffOnly } from '../auth/guards.js';

export function staffRoute(role: 'agent' | 'admin', ctx: AppContext): { preHandler: (request: FastifyRequest) => Promise<void> } {
  return { preHandler: staffOnly(ctx.env, role, ctx.now) };
}
