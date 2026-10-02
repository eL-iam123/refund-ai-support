import type { StaffSession } from './auth';
import type {
  Decision,
  RefundDto,
  AdminStatsDto,
  AuditChainDto,
  AuditEventDto,
  CustomerDto,
  OverrideDecision,
  OrderDto,
  PolicyDocumentDto,
  RefundRequestDto,
  RefundRequestSummaryDto,
  RuleOutcome,
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
  readonly source?: string | undefined;
  readonly customerId?: string | undefined;
  readonly q?: string | undefined;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    // The staff session cookie rides here on every call rather than at each call
    // site, so a new protected endpoint cannot be added without a credential by
    // mistake. It is httpOnly, so this is the only line in the client that has
    // anything to do with being signed in.
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init?.headers },
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

/** Where a return's current status leads. Terminal states are absent by design. */
export interface DuplicateNotice {
  /** The request that already existed, which is the one that was returned. */
  readonly ofRequestId: string;
  readonly firstReportedAt: string;
  readonly firstDecision: string;
}

export interface AuditFilter {
  readonly kind?: string;
  readonly requestId?: string;
  readonly since?: string;
  readonly q?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** One page of the audit log, plus the verdict over the whole chain. */
export interface AuditPage {
  readonly events: readonly AuditEventDto[];
  readonly total: number;
  readonly kinds: readonly string[];
  readonly audit: AuditChainDto;
}

export interface AgentRoutedReply {
  readonly agentConnected: boolean;
  /** The takeover's copy of the customer's message. */
  readonly message: {
    readonly id: string;
    readonly createdAt: string;
    readonly sender: 'customer';
    readonly body: string;
    readonly media: { readonly type: string; readonly url: string; readonly bytes: number } | null;
  };
}

/** One row of the live conversations list, from the staff endpoint. */
export interface StaffConversation {
  readonly customerId: string;
  readonly customerName: string;
  readonly orderId: string | null;
  readonly lastActivityAt: string;
  readonly activityCount: number;
  readonly activeHandoff: {
    readonly id: string;
    readonly agentId: string;
    readonly startedAt: string;
    /** Still the automatic escalation marker; no person has claimed it yet. */
    readonly unattended: boolean;
  } | null;
  /** Refusals the customer is asking a person to look at again. */
  readonly openAppeals: readonly { readonly requestId: string; readonly reason: string; readonly createdAt: string }[];
}

/** A thread entry as the staff console reads it. */
export type StaffThreadTurn =
  | {
      readonly kind: 'request';
      readonly requestId: string;
      readonly message: string;
      readonly responseText: string;
      readonly decision: Decision;
      readonly refundAmountCents: number;
      readonly createdAt: string;
    }
  | { readonly kind: 'dialogue'; readonly id: string; readonly message: string; readonly question: string; readonly createdAt: string }
  | { readonly kind: 'update'; readonly id: string; readonly requestId: string; readonly body: string; readonly createdAt: string }
  | {
      readonly kind: 'agent';
      readonly id: string;
      readonly sender: 'agent' | 'customer';
      readonly body: string;
      readonly createdAt: string;
      /** Optional photo attached to this message, served under `/media/`.
       *
       * Declared `| undefined` as well as `| null`: the field is absent, not
       * null, on a text message, so a `!== null` guard reads `.url` off
       * `undefined` and crashes the render. */
      readonly media: { readonly type: string; readonly url: string; readonly bytes: number } | null | undefined;
    }
  | { readonly kind: 'handoff'; readonly id: string; readonly body: string; readonly createdAt: string };

/** The deterministic briefing shown beside a takeover. */
export interface HandoffBrief {
  readonly state: 'ai' | 'handed_off';
  readonly customerId: string;
  readonly customerName: string;
  readonly orderId: string | null;
  readonly agentId: string | null;
  /** Live takeover still waiting for a person to claim it. */
  readonly unattended: boolean;
  readonly since: string | null;
  readonly chatClosed: { readonly closedAt: string; readonly closedBy: string; readonly requestId: string } | null;
  readonly canCloseChat: boolean;
  readonly handoffReason: string | null;
  readonly whatTheySaid: readonly { readonly at: string; readonly text: string }[];
  readonly dialogue: readonly { readonly question: string; readonly answer: string }[];
  readonly echoedEvidence: readonly string[];
  readonly claim:
    | {
        readonly summary: string;
        readonly decision: string;
        readonly refundAmountCents: number;
        readonly reasonCodes: readonly string[];
        readonly items: readonly string[];
      }
    | null;
  /**
   * One rule the pipeline ran on this case.
   *
   * `outcome` was `string`, which let the live console interpolate it straight
   * into a stylesheet class and quietly render every rule pill unstyled. It is
   * `RuleOutcome` because that is what the server sends, so an unexpected value
   * now fails at the type boundary instead of at review.
   */
  readonly policyTrail: readonly { readonly ruleId: string; readonly outcome: RuleOutcome; readonly evidence: string }[];
  readonly riskFlags: readonly { readonly label: string; readonly detail: string }[];
  /** Refusals the customer asked a person to look at again, oldest first. */
  readonly appeals: readonly { readonly requestId: string; readonly reason: string; readonly createdAt: string }[];
}

export const api = {
  health: (): Promise<{ status: string; aiMode: string; adminEnabled: boolean }> => request('/api/health'),

  /** The staff session, or a 401. Used to decide whether to render the console. */
  staffSession: (): Promise<StaffSession> => request('/api/admin/session'),

  signIn: (username: string, password: string): Promise<StaffSession> =>
    post('/api/admin/login', { username, password }),

  signOut: (): Promise<{ ok: boolean }> => post('/api/admin/logout', {}),

/**
   * Sends a message. Four possible replies, and they are not interchangeable: a
   * decision (`request`, with `duplicate` when the server recognised a repeat and
   * returned the earlier request instead of creating one - a 200 rather than a
   * 201 in that case), the assistant's clarifying question (`question`), or
   * `received` - the thread was handed to a person, the pipeline is off, and the
   * message was routed to them instead of being decided.
   *
   * `itemIds` is what the customer ticked in the item picker. It narrows the
   * claim to those lines; the server checks every id against the order it
   * resolved, so a stale or hand-written id is dropped rather than honoured.
   */
  sendMessage: (input: {
    customerId: string;
    orderId: string | null;
    message: string;
    itemIds?: readonly string[];
  }) =>
    post<
      | { request: RefundRequestDto; duplicate?: DuplicateNotice }
      | { question: string; dialogueId: string; itemIds: readonly string[] }
      | ({ received: true } & AgentRoutedReply)
    >('/api/chat/messages', input),

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

  /**
   * The audit trail, with the chain verdict from the same read.
   *
   * Not split into "fetch events" and "verify chain" calls: a log that shows
   * rows from one moment and an integrity badge from another can be wrong in the
   * dangerous direction, appearing intact over rows written after the check.
   */
  audit: (filter: AuditFilter = {}): Promise<AuditPage> =>
    request(`/api/admin/audit${auditQueryString(filter)}`),

  /**
   * The live takeover console.
   *
   * The list is what a queue is for; the thread + briefing is the case file;
   * the three verbs are the whole of what an agent can do. The customer's half
   * of the same feature is the ordinary chat endpoint - this console never
   * touches `customerId` from anywhere but the staff session and the list rows.
   */
  staffConversations: (): Promise<{ conversations: readonly StaffConversation[] }> =>
    request('/api/staff/conversations'),

  staffConversation: (customerId: string, orderId: string | null): Promise<{ thread: readonly StaffThreadTurn[]; brief: HandoffBrief }> => {
    const search = new URLSearchParams({ customerId });
    if (orderId !== null && orderId.length > 0) {
      search.set('orderId', orderId);
    }
    return request(`/api/staff/conversation?${search.toString()}`);
  },

  staffTakeOver: (customerId: string, orderId: string | null): Promise<{ handoff: { id: string; customerId: string; orderId: string | null; agentId: string; startedAt: string } }> =>
    post(`/api/staff/conversations/${encodeURIComponent(customerId)}/take-over`, { orderId }),

  staffMessage: (customerId: string, body: string, mediaDataUrl?: string): Promise<{ message: { id: string; createdAt: string; sender: string; body: string; media: { type: string; url: string; bytes: number } | null } }> =>
    post(`/api/staff/conversations/${encodeURIComponent(customerId)}/message`, { body, media: mediaDataUrl ? { dataUrl: mediaDataUrl } : undefined }),

  staffHandBack: (customerId: string): Promise<{ ended: { id: string; customerId: string; orderId: string | null; agentId: string; startedAt: string } }> =>
    post(`/api/staff/conversations/${encodeURIComponent(customerId)}/hand-back`, {}),

  staffCloseChat: (customerId: string, orderId: string | null): Promise<{ closure: { id: string; customerId: string; orderId: string | null; requestId: string; closedAt: string; closedBy: string; finalState: 'approved' | 'denied' } }> =>
    post(`/api/staff/conversations/${encodeURIComponent(customerId)}/close`, { orderId }),

  staffAnalytics: (): Promise<{ analytics: { openHandoffs: number; escalatedAwaiting: number; awaitingReviewCents: number; decisionsToday: { approved: number; denied: number; escalated: number }; averageTakeoverMinutes: number | null; since: string } }> =>
    request('/api/staff/analytics'),
};

function auditQueryString(filter: AuditFilter): string {
  const search = new URLSearchParams();
  for (const [key, value] of [
    ['kind', filter.kind],
    ['requestId', filter.requestId],
    ['since', filter.since],
    ['q', filter.q],
    ['limit', filter.limit],
    ['offset', filter.offset],
  ] as const) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

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
