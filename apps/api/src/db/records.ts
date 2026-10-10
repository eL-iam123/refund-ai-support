/** Internal record shapes. Dates are real Dates; money is integer cents. */

import type { Decision } from '@refund/shared';

type OrderStatus = 'delivered' | 'shipped' | 'processing' | 'cancelled';
type PaymentState = 'settled' | 'pending' | 'refunded' | 'partially_refunded' | 'chargeback_open';
type TrackingStatus = 'delivered' | 'in_transit' | 'not_shipped' | 'exception';
export type CustomerTier = 'standard' | 'plus' | 'enterprise';

export interface CustomerRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly tier: CustomerTier;
  readonly accountCreatedAt: Date;
  readonly accountAgeDays: number;
  readonly priorRefundCount: number;
  readonly refundRequestsLast30Days: number;
}

export interface OrderItemRecord {
  readonly id: string;
  readonly name: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
  readonly finalSale: boolean;
  readonly digital: boolean;
  readonly downloaded: boolean;
  /** This line is a recurring or renewal charge. Read by R-10 per item. */
  readonly isSubscription: boolean;
}

export interface OrderRecord {
  readonly id: string;
  readonly customerId: string;
  readonly placedAt: Date;
  readonly deliveredAt: Date | null;
  /** Age of the order for policy purposes: from delivery if delivered, else from placement. */
  readonly ageDays: number;
  readonly status: OrderStatus;
  readonly paymentState: PaymentState;
  readonly refundedCents: number;
  readonly totalCents: number;
  readonly isSubscription: boolean;
  readonly trackingStatus: TrackingStatus;
  readonly signedByCustomer: boolean;
  readonly conditionAtDelivery: string | null;
  readonly items: readonly OrderItemRecord[];
}

export interface PersistedRequest {
  /**
   * Why intake needed help, in the customer's words. Null when the model read the
   * message first time and no ladder step ran.
   */
  readonly ingestNotice: string | null;
  readonly id: string;
  readonly createdAt: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly orderId: string | null;
  readonly message: string;
  readonly decision: Decision;
  readonly refundAmountCents: number;
  readonly eligibleAmountCents: number;
  readonly summary: string;
  readonly policyRef: string;
  readonly traceJson: string;
  readonly overridesJson: string;
  readonly eligibleItemIdsJson: string;
  readonly claimItemIdsJson: string;
  readonly blockedItemsJson: string;
  readonly responseText: string;
  readonly extractionJson: string | null;
  readonly groundingJson: string | null;
  readonly injectionJson: string;
  readonly aiMode: string;
  readonly llmCalled: number;
  readonly timingsJson: string;
  readonly overriddenBy: string | null;
  readonly overrideNote: string | null;
  readonly scenarioId: string | null;
  /**
   * Agent-facing natural-language summary written by the model from the fixed
   * outcome and verified quotes. Null when no model was available or the summary
   * failed validation. Never customer-visible, never a decision input.
   */
  readonly caseSummary: string | null;
}

export interface AuditEventRecord {
  readonly id: number;
  readonly requestId: string;
  readonly at: string;
  readonly kind: string;
  readonly detail: string;
}

export interface LlmCallRecord {
  readonly id: number;
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
