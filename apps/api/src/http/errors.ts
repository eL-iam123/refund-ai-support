import type { ErrorResponseDto } from '@refund/shared';
import { UnknownCustomerError } from '../orchestrator.js';
import { AiUnavailableError } from '../ai/analyzer.js';
import { ShopAuthError } from '../shop/auth.js';
import { RefundBalanceExceededError } from '../db/refundLedger.js';

/**
 * One place that decides what a failure looks like on the wire.
 *
 * The mapping is deliberately small: a domain error keeps its message, an
 * unexpected error becomes a generic 500 with the detail logged but not
 * returned. Leaking a stack trace to a customer is a disclosure bug, and the
 * message is not a safe place for an internal path or a provider error.
 */

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class NotFoundError extends HttpError {
  constructor(what: string, id: string) {
    super(404, 'not_found', `no ${what} with id "${id}"`);
    this.name = 'NotFoundError';
  }
}

/** No credentials, or credentials that did not verify. Never says which. */
export class UnauthorizedError extends HttpError {
  /** The message is written for a shopper or an operator, not a log reader. */
  constructor(message = 'authentication is required') {
    super(401, 'unauthorized', message);
    this.name = 'UnauthorizedError';
  }
}

/** Valid credentials, insufficient role. */
export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, 'forbidden', message);
    this.name = 'ForbiddenError';
  }
}

/**
 * The override was well-formed and authorised, but the policy will not let this
 * particular reversal stand.
 *
 * 409, not 400: nothing about the request is malformed, and retrying it
 * unchanged will keep failing the same way. The agent has to change something -
 * acknowledge the hard block, or stop asking.
 */
export class OverrideRefusedError extends HttpError {
  constructor(message: string, readonly ruleIds: readonly string[] = []) {
    super(409, 'override_refused', message, ruleIds);
    this.name = 'OverrideRefusedError';
  }
}

export function badRequest(message: string, issues: readonly string[] = []): HttpError {
  return new HttpError(400, 'bad_request', message, issues);
}

/**
 * A request that is well-formed but conflicts with the current state of the
 * world: settling a refund that already settled, or one already released. The
 * caller did nothing wrong in the sense of a bad request, and retrying unchanged
 * will keep failing, so 409 is what tells a client - or a person - to look again
 * rather than to keep trying.
 */
export function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

/**
 * Raised when an override would produce a decision/amount pair that must not
 * exist - a refusal carrying money, or an approval carrying none.
 *
 * This is a 4xx, not a 500: the agent asked for something impossible, and the
 * right answer is to tell them why rather than to fail the request opaquely.
 * `assertDecisionCoherent` throws it so the invariant is enforced at the write,
 * and it travels to here so the message survives.
 */
export class IncoherentDecisionError extends HttpError {
  constructor(message: string) {
    super(422, 'incoherent_decision', message);
    this.name = 'IncoherentDecisionError';
  }
}

/** Safe mapping for client failures raised by Fastify before route handlers. */
function frameworkClientError(error: object): HttpError | null {
  if (!('statusCode' in error)) {
    return null;
  }
  const statusCode = Number(error.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode >= 500) {
    return null;
  }
  switch (statusCode) {
    case 413:
      return new HttpError(413, 'payload_too_large', 'request body is too large');
    case 429:
      return new HttpError(429, 'rate_limited', 'too many requests; try again later');
    default:
      return new HttpError(statusCode, 'bad_request', 'request could not be parsed');
  }
}

/** Maps any thrown value onto a status code and a stable error code. */
function knownDomainError(error: unknown): HttpError | null {
  if (error instanceof ShopAuthError) {
    return new HttpError(error.statusCode, error.statusCode === 401 ? 'unauthorized' : 'bad_request', error.message);
  }
  if (error instanceof RefundBalanceExceededError) {
    return new HttpError(409, 'refund_balance_exceeded', error.message);
  }
  if (error instanceof UnknownCustomerError) {
    return new HttpError(404, 'unknown_customer', error.message);
  }
  if (error instanceof AiUnavailableError) {
    return new HttpError(503, 'ai_unavailable', 'the model provider is unavailable');
  }
  return null;
}

/** Maps any thrown value onto a status code and a stable error code. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  const domain = knownDomainError(error);
  if (domain !== null) {
    return domain;
  }
  if (typeof error === 'object' && error !== null) {
    const mapped = frameworkClientError(error);
    if (mapped !== null) {
      return mapped;
    }
  }
  if (error instanceof Error) {
    return new HttpError(500, 'internal_error', 'an unexpected error occurred');
  }
  return new HttpError(500, 'internal_error', 'an unexpected error occurred');
}

export function toErrorResponse(error: HttpError): ErrorResponseDto {
  return {
    error: error.code,
    message: error.message,
    ...(error.issues.length > 0 ? { issues: [...error.issues] } : {}),
  };
}
