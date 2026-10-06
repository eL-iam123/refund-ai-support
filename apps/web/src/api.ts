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
  ReturnStatus,
  Carrier,
  ShopAnswerDto,
} from '@refund/shared';

/**
 * Thin typed wrapper over the API.
 *
 * Every call goes through `request`, which is the only place that knows how
 * failures arrive. The API's error envelope is a stable contract, so a 4xx is
 * a typed result rather than an exception the UI has to guess at.
 */

import { ApiError, request, post } from './httpClient';

/**
 * One line as the item picker offers it.
 *
 * `reported` means the line already has a decided request, so it is shown
 * disabled rather than hidden: a list that silently omits a line reads as a
 * list of everything the customer bought, which is not what it is. Lines with
 * only an open escalation stay enabled - nothing has been decided about them,
 * and the follow-up routes through the open case.
 */
export interface ItemChoice {
  readonly itemId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly reported: boolean;
}

/**
 * The picker's offer: a list to render, not a decision.
 *
 * The customer taps a line, and the scope that reaches the money is what they
 * tapped on their next message - never anything in this object.
 */
export interface ItemPickerOffer {
  readonly orderId: string;
  readonly items: readonly ItemChoice[];
  /** The lines the model was unsure about. Empty when it was unsure about all of them. */
  readonly suggested: readonly string[];
}

export { ApiError };

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

export interface RequestFilter {
  readonly decision?: string | undefined;
  readonly source?: string | undefined;
  readonly customerId?: string | undefined;
  readonly q?: string | undefined;
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
  /**
   * The item slice the live takeover speaks for. Null when there is no live
   * takeover or it predates forks — the queue then shows the thread as
   * before, with no case boundary to name.
   */
  readonly forkScope: { readonly orderId: string; readonly itemIds: readonly string[] } | null;
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

/**
 * A return, as the staff console sees it.
 *
 * Declared here rather than imported from the API package, like the rest of this
 * file's shapes: the console is a client of the HTTP contract, and a client that
 * imports the server's types stops noticing when the two drift.
 */
export interface ReturnDto {
  readonly id: string;
  readonly requestId: string | null;
  readonly orderId: string;
  readonly customerId: string;
  readonly status: ReturnStatus;
  readonly reason: string;
  readonly trackingNumber: string | null;
  readonly carrier: Carrier | null;
  readonly labelUrl: string | null;
  readonly shippedAt: string | null;
  readonly receivedAt: string | null;
  readonly processedAt: string | null;
  readonly deniedAt: string | null;
  readonly deniedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReturnItemDto {
  readonly id: string;
  readonly returnId: string;
  readonly itemId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly receivedQuantity: number;
  /** What it looked like on arrival; null until the parcel has been received. */
  readonly condition: string | null;
  readonly restockedQuantity: number;
}

/**
 * A return with the moves that are legal from where it stands.
 *
 * `nextStates` comes from the server rather than from a table copied into this
 * file, so the buttons on the page are the server's rules rather than a guess at
 * them that goes stale the first time a state is added.
 */
export interface ReturnDetailDto {
  readonly return: ReturnDto;
  readonly items: readonly ReturnItemDto[];
  readonly nextStates: readonly ReturnStatus[];
  readonly canDeny: boolean;
}

export const api = {
  health: (): Promise<{ status: string; aiMode: string; adminEnabled: boolean }> => request('/api/health'),

  /** The staff session, or a 401. Used to decide whether to render the console. */
  staffSession: (): Promise<StaffSession> => request('/api/admin/session'),

  signIn: (username: string, password: string): Promise<StaffSession> =>
    post('/api/admin/login', { username, password }),

  signOut: (): Promise<{ ok: boolean }> => post('/api/admin/logout', {}),

/**
   * Sends a message. Five possible replies, and they are not interchangeable: a
   * decision (`request`, with `duplicate` when the server recognised a repeat and
   * returned the earlier request instead of creating one - a 200 rather than a
   * 201 in that case), the assistant's clarifying question (`question`),
   * `received` - the thread was handed to a person, the pipeline is off, and the
   * message was routed to them instead of being decided - or a shopping answer
   * (`shopAnswer`), which wrote a shopping thread row and no request.
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
    shopping?: boolean;
  }) =>
    post<
      | { request: RefundRequestDto; duplicate?: DuplicateNotice }
      | {
          question: string;
          /** The item picker offered instead of a question, when one was. */
          picker: ItemPickerOffer | null;
          dialogueId: string;
          itemIds: readonly string[];
          /** Where the pipeline stopped, for the pending bubble. */
          progressStage: string | null;
        }
      | ({ received: true } & AgentRoutedReply)
      | { shopAnswer: ShopAnswerDto }
      | { status: string; requestId: string }
    >('/api/chat/messages', input),

  listRequests: (params: RequestFilter = {}) =>
    request<{ requests: RefundRequestSummaryDto[] }>(`/api/requests${queryString(params)}`),

  requestDetail: (id: string): Promise<RequestDetail> => request(`/api/requests/${id}`),

  override: (id: string, decision: OverrideDecision) =>
    post<{ request: RefundRequestDto }>(`/api/requests/${id}/override`, decision),
  fulfilOutcome: (id: string, note: string) =>
    post<{ request: RefundRequestDto }>(`/api/requests/${id}/fulfil`, { note }),

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

  /* Returns: the parcel. Five moves, each one the only legal move from its state. */
  listStaffReturns: (): Promise<{ returns: readonly ReturnDto[] }> => request('/api/admin/returns'),
  staffReturn: (id: string): Promise<ReturnDetailDto> => request(`/api/admin/returns/${id}`),
  labelReturn: (id: string, body: { carrier: Carrier; labelUrl: string }) =>
    post<ReturnDetailDto>(`/api/admin/returns/${id}/label`, body),
  shipReturn: (id: string, body: { carrier: Carrier; trackingNumber: string }) =>
    post<ReturnDetailDto>(`/api/admin/returns/${id}/ship`, body),
  receiveReturn: (
    id: string,
    body: { lines: readonly { itemId: string; quantity: number; condition: string }[] },
  ) => post<ReturnDetailDto>(`/api/admin/returns/${id}/receive`, body),
  processReturn: (id: string, body: { restock: readonly { itemId: string; quantity: number }[] }) =>
    post<ReturnDetailDto>(`/api/admin/returns/${id}/process`, body),
  denyReturn: (id: string, reason: string) =>
    post<ReturnDetailDto>(`/api/admin/returns/${id}/deny`, { reason }),

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

  staffConversation: (customerId: string, orderId: string | null, handoffId?: string): Promise<{ thread: readonly StaffThreadTurn[]; brief: HandoffBrief }> => {
    const search = new URLSearchParams({ customerId });
    if (orderId !== null && orderId.length > 0) {
      search.set('orderId', orderId);
    }
    if (handoffId !== undefined && handoffId.length > 0) {
      search.set('handoffId', handoffId);
    }
    return request(`/api/staff/conversation?${search.toString()}`);
  },

  staffTakeOver: (customerId: string, orderId: string | null): Promise<{ handoff: { id: string; customerId: string; orderId: string | null; agentId: string; startedAt: string } }> =>
    post(`/api/staff/conversations/${encodeURIComponent(customerId)}/take-over`, { orderId }),

  staffMessage: (customerId: string, body: string, mediaDataUrl?: string): Promise<{ message: { id: string; createdAt: string; sender: string; body: string; media: { type: string; url: string; bytes: number } | null } }> =>
    post(`/api/staff/conversations/${encodeURIComponent(customerId)}/message`, { body, media: mediaDataUrl ? { dataUrl: mediaDataUrl } : undefined }),

  staffHandBack: (customerId: string): Promise<{ ended: { id: string; customerId: string; orderId: string | null; agentId: string; startedAt: string } }> =>
    post(`/api/staff/conversations/${encodeURIComponent(customerId)}/hand-back`, {}),

  staffCloseChat: (customerId: string, orderId: string | null): Promise<{ closure: { id: string; customerId: string; orderId: string | null; requestId: string; closedAt: string; closedBy: string; finalState: Decision } }> =>
    post(`/api/staff/conversations/${encodeURIComponent(customerId)}/close`, { orderId }),

  staffAnalytics: (): Promise<{ analytics: { openHandoffs: number; escalatedAwaiting: number; awaitingReviewCents: number; decisionsToday: Record<Decision, number>; averageTakeoverMinutes: number | null; since: string } }> =>
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
