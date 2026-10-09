import { z } from 'zod';
import {
  DECISIONS,
  INJECTION_CATEGORIES,
  INTENTS,
  ITEM_CONDITIONS,
  OVERRIDE_CODES,
  PRECEDENCE,
  REASON_CODES,
  RULE_CLASSES,
  RULE_IDS,
  RULE_OUTCOMES,
  RULE_SCOPES,
  STAGES,
  type StageTiming,
} from './domain.js';

// --- Inbound ----------------------------------------------------------------

/**
 * The customer-facing request body.
 *
 * Deliberately three fields. The amount, the decision, the policy and the
 * customer's identity are all derived server-side, so none of them can appear
 * here for a caller to fill in - Zod strips unknown keys rather than trusting
 * them, which is what makes mass assignment a non-issue rather than a promise.
 */
export const CreateRefundRequestSchema = z.object({
  customerId: z.string().min(1, 'customerId is required'),
  message: z.string().min(1, 'message is required'),
  /** Optional: the chat surface knows which order the customer is looking at. */
  orderId: z.string().min(1).nullable().default(null),
  /**
   * Order lines the customer ticked, by `order_items.id`.
   *
   * This is how the storefront says "the mug, not the rest" without the
   * customer having to describe it in words. Ids rather than names, because a
   * name is a guess: two lines on one order can share it, and a mistyped or
   * reworded name silently matches nothing and turns a specific claim back into
   * a whole-order one. Every id is checked against the resolved order before it
   * is used, so this narrows what is claimed and can never widen it.
   */
  itemIds: z.array(z.string().min(1)).max(25).optional().default([]),
});
export type CreateRefundRequest = z.infer<typeof CreateRefundRequestSchema>;

export const OverrideDecisionSchema = z
  .object({
    decision: z.enum(DECISIONS),
    // Trimmed first, then length-checked: an all-whitespace note is no
    // justification at all, and an override nobody can account for is exactly
    // what this table exists to prevent.
    note: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1, 'a human override must be justified').max(2000)),
    // There is deliberately no `agentId` here. The acting staff member comes from
    // the verified token, never the request body: an audit trail that records a
    // name the caller chose is not an audit trail, it is a comment box.
    /**
     * Required to approve a request the policy refused for a hard reason.
     *
     * Deliberately a separate boolean rather than something inferred from the
     * note: the note is prose nobody can check, and the whole point is that
     * reversing a hard denial has to be a deliberate act, not a slip.
     */
    acknowledgeHardBlock: z.boolean().optional(),
    /**
     * The amount a `partial_refund` authorises. Required for that decision,
     * forbidden for every other: an approval re-derives the full eligible amount
     * and a non-money outcome carries none, so a figure on either would be a
     * second, conflicting source of truth.
     */
    amountCents: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    const needsAmount = value.decision === 'partial_refund';
    if (needsAmount && value.amountCents === undefined) {
      ctx.addIssue({ code: 'custom', path: ['amountCents'], message: 'a partial refund must name the amount to authorise' });
    }
    if (!needsAmount && value.amountCents !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['amountCents'], message: `a ${value.decision} override cannot carry an amount` });
    }
  });
export type OverrideDecision = z.infer<typeof OverrideDecisionSchema>;

export const RefundStatusSchema = z.enum(['pending_verification', 'settled', 'released']);
export type RefundStatusDto = z.infer<typeof RefundStatusSchema>;

/**
 * One ledger row. `pending_verification` is the state an approved-but-unpaid
 * refund sits in, and the presence of that state in a client's vocabulary is the
 * honest description of the system: an approval is not a payment.
 */
export const RefundSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  orderId: z.string(),
  customerId: z.string(),
  amountCents: z.number().int().positive(),
  currency: z.literal('USD'),
  status: RefundStatusSchema,
  idempotencyKey: z.string(),
  createdAt: z.string(),
  verifiedBy: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
  releaseReason: z.string().nullable(),
});
export type RefundDto = z.infer<typeof RefundSchema>;

/**
 * Where a request came from. Scenario fixtures are replayed history for the
 * demo console; storefront rows are real requests from the shop. They are told
 * apart so a reviewer can see that the demo surface is seeded data and that a
 * testing session is not, instead of both reading as the same authority.
 */
export const RequestSourceSchema = z.enum(['scenario', 'storefront']);
export type RequestSourceDto = z.infer<typeof RequestSourceSchema>;

export const ListRequestsQuerySchema = z.object({
  decision: z.enum(DECISIONS).optional(),
  source: RequestSourceSchema.optional(),
  customerId: z.string().optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListRequestsQuery = z.infer<typeof ListRequestsQuerySchema>;

/**
 * The admin log filter.
 *
 * `since` is a plain ISO instant rather than a "7d"/"24h" shorthand: the string
 * that reaches SQLite has to be comparable against the stored `at` values with
 * no conversion step, and a shorthand would put that conversion somewhere it
 * could be forgotten.
 */
export const ListAuditQuerySchema = z.object({
  kind: z.string().max(60).optional(),
  requestId: z.string().max(80).optional(),
  since: z.string().max(40).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type ListAuditQuery = z.infer<typeof ListAuditQuerySchema>;

export const AuditEventDtoSchema = z.object({
  id: z.number().int(),
  requestId: z.string(),
  at: z.string(),
  kind: z.string(),
  detail: z.string(),
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditEventDto = z.infer<typeof AuditEventDtoSchema>;

/**
 * The chain verdict, as a flat object rather than a union.
 *
 * `brokenAtId` and `reason` are nullable rather than absent on success, so a
 * client can read the same two keys either way instead of narrowing on `ok`
 * first and risking a property read on the wrong shape.
 */
export const AuditChainDtoSchema = z.object({
  ok: z.boolean(),
  checked: z.number().int(),
  headHash: z.string().nullable(),
  brokenAtId: z.number().int().nullable(),
  reason: z.string().nullable(),
});
export type AuditChainDto = z.infer<typeof AuditChainDtoSchema>;

// --- Outbound ---------------------------------------------------------------

export const RuleEvaluationSchema = z.object({
  ruleId: z.enum(RULE_IDS),
  ruleClass: z.enum(RULE_CLASSES),
  scope: z.enum(RULE_SCOPES),
  outcome: z.enum(RULE_OUTCOMES),
  evidence: z.string(),
  policyRef: z.string(),
  itemIds: z.array(z.string()),
});
export type RuleEvaluationDto = z.infer<typeof RuleEvaluationSchema>;

export const AiProposalSchema = z.object({
  suggestedDecision: z.enum(DECISIONS),
  suggestedAmountCents: z.number().int().nonnegative(),
  confidence: z.number(),
  reason: z.enum(REASON_CODES),
  model: z.string(),
});
export type AiProposalDto = z.infer<typeof AiProposalSchema>;

export const OverrideRecordSchema = z.object({
  code: z.enum(OVERRIDE_CODES),
  detail: z.string(),
  aiProposal: AiProposalSchema.nullable(),
});
export type OverrideRecordDto = z.infer<typeof OverrideRecordSchema>;

export const BlockedItemSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  priceCents: z.number().int(),
  ruleId: z.enum(RULE_IDS),
  reason: z.string(),
});
export type BlockedItemDto = z.infer<typeof BlockedItemSchema>;

export const RefundDecisionSchema = z.object({
  decision: z.enum(DECISIONS),
  refundAmountCents: z.number().int().nonnegative(),
  eligibleAmountCents: z.number().int().nonnegative(),
  currency: z.literal('USD'),
  summary: z.string(),
  policyRef: z.string(),
  trace: z.array(RuleEvaluationSchema),
  overrides: z.array(OverrideRecordSchema),
  eligibleItemIds: z.array(z.string()),
  blockedItems: z.array(BlockedItemSchema),
  /**
   * Money already committed to this order by earlier claims: refunded, or
   * approved and waiting for a person to check it.
   *
   * Carried on the decision so the reply can mention it. Without it a customer
   * whose order is fully reserved is told "we are not able to refund this order"
   * while a refund for that same order is sitting pending - two true statements
   * that read as a contradiction, and the customer believes the refund was
   * refused. Deterministic, never model-derived, so the reply built from it is
   * as trustworthy as the decision itself.
   */
  outstandingAmountCents: z.number().int().nonnegative().default(0),
  outstandingState: z.enum(['none', 'pending', 'settled', 'mixed']).default('none'),
});
export type RefundDecisionDto = z.infer<typeof RefundDecisionSchema>;

export const LineClaimSchema = z.object({
  itemId: z.string(),
  reason: z.enum(REASON_CODES),
  condition: z.enum(ITEM_CONDITIONS),
  confidence: z.number().min(0).max(1),
  evidenceQuotes: z.array(z.string()).max(10),
});

export const ClaimExtractionSchema = z.object({
  intent: z.enum(INTENTS),
  reason: z.enum(REASON_CODES),
  condition: z.enum(ITEM_CONDITIONS),
  confidence: z.number().min(0).max(1),
  orderRef: z.string().nullable(),
  claimedAmountCents: z.number().int().nonnegative().nullable(),
  items: z.array(z.string()).max(10),
  evidenceQuotes: z.array(z.string()).max(10),
  language: z.string().max(32),
  urgency: z.enum(['low', 'normal', 'high']),
  policyOverrideAttempted: z.boolean(),
  lineClaims: z.array(LineClaimSchema).max(20).default([]),
});
export type ClaimExtractionDto = z.infer<typeof ClaimExtractionSchema>;

export const LineGroundingSchema = z.object({
  itemId: z.string(),
  grounded: z.boolean(),
  verifiedQuotes: z.array(z.string()),
  rejectedQuotes: z.array(z.string()),
});

export const GroundingSchema = z.object({
  grounded: z.boolean(),
  verifiedQuotes: z.array(z.string()),
  rejectedQuotes: z.array(z.string()),
  lines: z.array(LineGroundingSchema).default([]),
});
export type GroundingDto = z.infer<typeof GroundingSchema>;

export const InjectionSignalSchema = z.object({
  category: z.enum(INJECTION_CATEGORIES),
  pattern: z.string(),
  matchedText: z.string(),
});
export type InjectionSignalDto = z.infer<typeof InjectionSignalSchema>;

export const InjectionScanSchema = z.object({
  detected: z.boolean(),
  signals: z.array(InjectionSignalSchema),
  obfuscationNoted: z.boolean(),
});
export type InjectionScanDto = z.infer<typeof InjectionScanSchema>;

export const StageTimingSchema: z.ZodType<StageTiming> = z.object({
  stage: z.enum(STAGES),
  durationMs: z.number().nonnegative(),
  detail: z.string(),
});
export type StageTimingDto = z.infer<typeof StageTimingSchema>;

export const RefundRequestSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  orderId: z.string().nullable(),
  source: RequestSourceSchema,
  message: z.string(),
  decision: RefundDecisionSchema,
  /** Composed, deterministic customer-facing reply. */
  responseText: z.string(),
  /**
   * Why intake needed help, in the words the customer was given: a model that could
   * not be reached, a retry that worked, a message nobody could read. Null when the
   * model read it first time, which is most of them.
   */
  ingestNotice: z.string().nullable(),
  extraction: ClaimExtractionSchema.nullable(),
  grounding: GroundingSchema.nullable(),
  injection: InjectionScanSchema,
  aiMode: z.string(),
  llmCalled: z.boolean(),
  timings: z.array(StageTimingSchema),
  overriddenBy: z.string().nullable(),
  overrideNote: z.string().nullable(),
  /**
   * Agent-facing natural-language summary of the case, written by the model from
   * the fixed outcome and verified quotes. Null when no model was available or the
   * summary failed validation. Never customer-visible, never a decision input.
   */
  caseSummary: z.string().nullable(),
  /** The last recorded pipeline stage, for staged progress UX. */
  progressStage: z.enum(STAGES),
});
export type RefundRequestDto = z.infer<typeof RefundRequestSchema>;

export const RefundRequestSummarySchema = RefundRequestSchema.pick({
  id: true,
  createdAt: true,
  customerId: true,
  customerName: true,
  orderId: true,
  source: true,
  message: true,
  overriddenBy: true,
}).extend({
  decision: z.enum(DECISIONS),
  refundAmountCents: z.number().int().nonnegative(),
  reasonCodes: z.array(z.enum(RULE_IDS)),
  aiMode: z.string(),
  llmCalled: z.boolean(),
  injectionDetected: z.boolean(),
});
export type RefundRequestSummaryDto = z.infer<typeof RefundRequestSummarySchema>;

export const CustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  tier: z.enum(['standard', 'plus', 'enterprise']),
  accountAgeDays: z.number().int().nonnegative(),
  priorRefundCount: z.number().int().nonnegative(),
  refundRequestsLast30Days: z.number().int().nonnegative(),
});
export type CustomerDto = z.infer<typeof CustomerSchema>;

export const OrderItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  unitPriceCents: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
  finalSale: z.boolean(),
  digital: z.boolean(),
  downloaded: z.boolean(),
});
export type OrderItemDto = z.infer<typeof OrderItemSchema>;

export const OrderSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  placedAt: z.string(),
  deliveredAt: z.string().nullable(),
  ageDays: z.number().int(),
  status: z.enum(['delivered', 'shipped', 'processing', 'cancelled']),
  paymentState: z.enum(['settled', 'pending', 'refunded', 'partially_refunded', 'chargeback_open']),
  refundedCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  isSubscription: z.boolean(),
  trackingStatus: z.enum(['delivered', 'in_transit', 'not_shipped', 'exception']),
  signedByCustomer: z.boolean(),
  conditionAtDelivery: z.string().nullable(),
  items: z.array(OrderItemSchema),
});
export type OrderDto = z.infer<typeof OrderSchema>;

export const AdminStatsSchema = z.object({
  total: z.number().int(),
  byDecision: z.record(z.enum(DECISIONS), z.number().int()),
  llmCalls: z.number().int(),
  injectionAttempts: z.number().int(),
  clampsFired: z.number().int(),
  humanOverrides: z.number().int(),
  aiMode: z.string(),
  averageLatencyMs: z.number().nonnegative(),

  /**
   * Whether a model is actually configured.
   *
   * Reported separately from `aiMode` because a mode label is not an answer to
   * "is it working": a deployment with no key still produces an `aiMode`, and
   * that label is the whole reason the dashboard can look healthy while nothing
   * is being called.
   */
  aiAvailable: z.boolean(),
  aiUnavailableReason: z.string().nullable(),
  /**
   * What each candidate model's circuit breaker is doing.
   *
   * Published here rather than only on `/api/health` because this is the payload the
   * operator's eye is already on, and "a model is out of rotation" is the first thing
   * worth knowing when the numbers stop moving.
   */
  models: z.array(
    z.object({
      model: z.string(),
      state: z.enum(['closed', 'open', 'half_open']),
      consecutiveFailures: z.number().int().nonnegative(),
    }),
  ),

  /** Money the system has promised but not paid. */
  pendingVerification: z.object({
    count: z.number().int(),
    amountCents: z.number().int(),
  }),
  /** Money actually paid out. */
  settled: z.object({
    count: z.number().int(),
    amountCents: z.number().int(),
  }),
  /** Reservations given back, with the reason, for the "why is this still claimable" question. */
  released: z.object({
    count: z.number().int(),
    amountCents: z.number().int(),
  }),

  /** How long the pipeline actually takes, not just its mean. */
  latency: z.object({
    averageMs: z.number().nonnegative(),
    p95Ms: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
  }),

  /** Model attempts by outcome, so a 100% success rate is visibly 100%. */
  llm: z.object({
    attempts: z.number().int(),
    failed: z.number().int(),
    averageMs: z.number().nonnegative(),
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    providers: z.array(z.object({ provider: z.string(), attempts: z.number().int(), failed: z.number().int() })),
  }),

  /** Which rules are actually deciding things. A rule that never fires is a rule to delete. */
  topRules: z.array(z.object({ ruleId: z.string(), fired: z.number().int() })),

  /**
   * Requests per day, oldest first, for the sparkline.
   *
   * `byDecision` rather than one field per outcome: a fixed set of columns has to
   * be edited every time a decision value is added, and the day it is forgotten
   * the series stop summing to `total` - which reads as decisions going missing
   * rather than as a column nobody added.
   */
  daily: z.array(z.object({ day: z.string(), total: z.number().int(), byDecision: z.record(z.enum(DECISIONS), z.number().int()) })),

  /**
   * Where the policy disagreed with what was asked for.
   *
   * `modelSaidYesPolicySaidNo` predates the removal of model proposals and keeps
   * its name for continuity; what it now counts is the case that would still show
   * a resolver bug as a payout - a claim naming a figure that came back denied.
   */
  clampRate: z.object({
    /** Requests whose overrides record a clamped, zeroed or overruled amount. */
    clamped: z.number().int(),
    /** Requests where money was asked for, the claim was read, and the policy paid nothing. */
    modelSaidYesPolicySaidNo: z.number().int(),
  }),
});
export type AdminStatsDto = z.infer<typeof AdminStatsSchema>;

export const PolicyRuleDocSchema = z.object({
  id: z.enum(RULE_IDS),
  title: z.string(),
  class: z.enum(RULE_CLASSES),
  scope: z.enum(RULE_SCOPES),
  stage: z.enum(STAGES),
  policyRef: z.string(),
  summary: z.string(),
  outcomes: z.array(z.enum(RULE_OUTCOMES)),
});
export type PolicyRuleDocDto = z.infer<typeof PolicyRuleDocSchema>;

export const PolicyDocumentSchema = z.object({
  version: z.string(),
  precedence: z.object({ deny: z.number(), escalate: z.number(), approve: z.number() }),
  allowedOutcomes: z.record(z.enum(RULE_CLASSES), z.array(z.enum(RULE_OUTCOMES))),
  rules: z.array(PolicyRuleDocSchema),
});
export type PolicyDocumentDto = z.infer<typeof PolicyDocumentSchema>;

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  issues: z.array(z.string()).optional(),
});
export type ErrorResponseDto = z.infer<typeof ErrorResponseSchema>;

export { PRECEDENCE };
