import { authHeaders } from './auth';
import type {
  RefundDto,
  AdminStatsDto,
  CustomerDto,
  OverrideDecision,
  OrderDto,
  PolicyDocumentDto,
  RefundRequestDto,
  RefundRequestSummaryDto,
  Scenario,
} from '@refund/shared';

/**
 * Thin typed wrapper over the API.
 *
 * Every call goes through `request`, which is the only place that knows how
 * failures arrive. The API's error envelope is a stable contract, so a 4xx is
 * a typed result rather than an exception the UI has to guess at.
 */

export interface AuditEvent {
  readonly requestId: string;
  readonly at: string;
  readonly kind: string;
  readonly detail: string;
}

export interface LlmCall {
  readonly requestId: string;
  readonly at: string;
  readonly purpose: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly ok: number;
  readonly latencyMs: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly error: string | null;
}

export interface RequestDetail {
  readonly request: RefundRequestDto;
  readonly audit: readonly AuditEvent[];
  readonly llmCalls: readonly LlmCall[];
}

/** A failed call, carrying the API's own error code and field issues. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorEnvelope {
  readonly error?: string;
  readonly message?: string;
  readonly issues?: readonly string[];
}

export interface RequestFilter {
  readonly decision?: string | undefined;
  readonly customerId?: string | undefined;
  readonly q?: string | undefined;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    // The staff token rides here on every call rather than at each call site, so
    // a new protected endpoint cannot be added without a credential by mistake.
    headers: { 'content-type': 'application/json', ...authHeaders(), ...init?.headers },
  });

  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope = {};
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    // A non-JSON error body (a proxy timeout, say) still has to surface as
    // something the UI can render, so fall back to the status line.
  }
  return new ApiError(
    response.status,
    envelope.error ?? 'http_error',
    envelope.message ?? `request failed with status ${response.status}`,
    envelope.issues ?? [],
  );
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export const api = {
  health: (): Promise<{ status: string; aiMode: string }> => request('/api/health'),

  sendMessage: (input: { customerId: string; orderId: string | null; message: string }) =>
    post<{ request: RefundRequestDto }>('/api/chat/messages', input),

  listRequests: (params: RequestFilter = {}) =>
    request<{ requests: RefundRequestSummaryDto[] }>(`/api/requests${queryString(params)}`),

  requestDetail: (id: string): Promise<RequestDetail> => request(`/api/requests/${id}`),

  override: (id: string, decision: OverrideDecision) =>
    post<{ request: RefundRequestDto }>(`/api/requests/${id}/override`, decision),

  stats: (): Promise<{ stats: AdminStatsDto }> => request('/api/admin/stats'),

  customers: (): Promise<{ customers: CustomerDto[] }> => request('/api/customers'),

  orders: (customerId: string): Promise<{ orders: OrderDto[] }> =>
    request(`/api/customers/${customerId}/orders`),

  scenarios: (): Promise<{ scenarios: readonly Scenario[] }> => request('/api/scenarios'),

  policy: (): Promise<{ policy: PolicyDocumentDto }> => request('/api/policy'),

  /** The identity the server will attribute this session's actions to. */
  whoami: (): Promise<{ subject: string; role: string; expiresAt: string }> => request('/api/whoami'),

  /** The verification queue: approvals that are authorised but not yet paid. */
  pendingRefunds: (): Promise<{ refunds: RefundDto[] }> => request('/api/refunds?status=pending_verification'),

  settleRefund: (id: string): Promise<{ refund: RefundDto }> => post(`/api/refunds/${id}/settle`, {}),

  releaseRefund: (id: string, reason: string): Promise<{ refund: RefundDto }> =>
    post(`/api/refunds/${id}/release`, { reason }),
};

function queryString(params: RequestFilter): string {
  const search = new URLSearchParams();
  for (const [key, value] of [
    ['decision', params.decision],
    ['customerId', params.customerId],
    ['q', params.q],
  ] as const) {
    if (value !== undefined && value.length > 0) {
      search.set(key, value);
    }
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

/** Turns any thrown value into something renderable, including field-level issues. */
export function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.issues.length > 0 ? `${cause.message} (${cause.issues.join('; ')})` : cause.message;
  }
  return cause instanceof Error ? cause.message : 'something went wrong';
}
