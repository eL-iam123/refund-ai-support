import type { FastifyInstance } from 'fastify';
import { SCENARIOS, type OrderDto, type PolicyDocumentDto } from '@refund/shared';
import { aiModeLabel, type AppContext } from '../context.js';
import { listCustomers, listOrdersForCustomer } from '../../db/orderRepository.js';
import { adminStats } from '../../db/statsRepository.js';
import { POLICY_RULES } from '../../policy/rules/index.js';
import { ALLOWED_OUTCOMES, PRECEDENCE } from '@refund/shared';
import { NotFoundError } from '../errors.js';
import { findCustomer } from '../../db/sql.js';
import { staffOnly } from '../../auth/guards.js';

/**
 * GET /api/customers, /api/customers/:id/orders, /api/scenarios, /api/policy, /api/admin/stats
 *
 * The read-only surface the customer and admin front-ends need. `/api/policy`
 * is generated from the same `POLICY_RULES` literal the engine evaluates, so
 * the documented policy cannot drift from the enforced one.
 */
export function registerCatalogRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Every route here except `/api/policy` returns customer data. Names, emails
  // and order histories are not public, so each one states who may read it.
  // `/api/policy` stays open: the policy is published to customers anyway, and
  // withholding it would only make the rules harder to appeal.
  const staff = (role: 'agent' | 'admin') => ({
    preHandler: staffOnly(ctx.env, role, ctx.now),
  });

  app.get('/api/customers', staff('admin'), () => {
    const now = ctx.now();
    return {
      customers: listCustomers(ctx.db, now).map((customer) => ({
        id: customer.id,
        name: customer.name,
        email: customer.email,
        tier: customer.tier,
        accountAgeDays: customer.accountAgeDays,
        priorRefundCount: customer.priorRefundCount,
        refundRequestsLast30Days: customer.refundRequestsLast30Days,
      })),
    };
  });

  app.get('/api/customers/:id/orders', staff('agent'), (request) => {
    const params = request.params as { id: string };
    const now = ctx.now();
    const customer = findCustomer(ctx.db, params.id, now);
    if (customer === null) {
      throw new NotFoundError('customer', params.id);
    }
    const orders = listOrdersForCustomer(ctx.db, params.id, now);
    return { customer: { id: customer.id, name: customer.name }, orders: orders.map(toOrderDto) };
  });

  app.get('/api/scenarios', staff('agent'), () => {
    // The fixture definitions, not live requests: this is the admin tab that
    // explains what each scenario is for and what it should produce.
    return { scenarios: SCENARIOS };
  });

  app.get('/api/policy', () => {
    return { policy: policyDocument() };
  });

  app.get('/api/admin/stats', staff('admin'), () => {
    return {
      stats: adminStats(ctx.db, aiModeLabel(ctx.pipeline), {
        available: ctx.pipeline.analyzer.available,
        reason: ctx.pipeline.analyzer.unavailableReason,
        models: ctx.pipeline.analyzer.breakerState?.() ?? [],
      }),
    };
  });

}

function toOrderDto(order: {
  id: string;
  customerId: string;
  placedAt: Date;
  deliveredAt: Date | null;
  ageDays: number;
  status: string;
  paymentState: string;
  refundedCents: number;
  totalCents: number;
  isSubscription: boolean;
  trackingStatus: string;
  signedByCustomer: boolean;
  conditionAtDelivery: string | null;
  items: readonly {
    id: string;
    name: string;
    unitPriceCents: number;
    quantity: number;
    finalSale: boolean;
    digital: boolean;
    downloaded: boolean;
  }[];
}): OrderDto {
  return {
    id: order.id,
    customerId: order.customerId,
    placedAt: order.placedAt.toISOString(),
    deliveredAt: order.deliveredAt === null ? null : order.deliveredAt.toISOString(),
    ageDays: order.ageDays,
    status: order.status as OrderDto['status'],
    paymentState: order.paymentState as OrderDto['paymentState'],
    refundedCents: order.refundedCents,
    totalCents: order.totalCents,
    isSubscription: order.isSubscription,
    trackingStatus: order.trackingStatus as OrderDto['trackingStatus'],
    signedByCustomer: order.signedByCustomer,
    conditionAtDelivery: order.conditionAtDelivery,
    items: order.items.map((item) => ({
      id: item.id,
      name: item.name,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      finalSale: item.finalSale,
      digital: item.digital,
      downloaded: item.downloaded,
    })),
  };
}

/** Built from the live rule objects, so the doc is never out of date. */
function policyDocument(): PolicyDocumentDto {
  return {
    version: '1.0.0',
    precedence: { deny: PRECEDENCE.deny, escalate: PRECEDENCE.escalate, approve: PRECEDENCE.approve },
    allowedOutcomes: {
      eligibility: [...ALLOWED_OUTCOMES.eligibility],
      'approval-authority': [...ALLOWED_OUTCOMES['approval-authority']],
      risk: [...ALLOWED_OUTCOMES.risk],
      integrity: [...ALLOWED_OUTCOMES.integrity],
    },
    rules: POLICY_RULES.map((rule) => ({
      id: rule.id,
      title: rule.title,
      class: rule.ruleClass,
      scope: rule.scope,
      stage: rule.stage,
      policyRef: rule.policyRef,
      summary: rule.summary,
      // The allowed set is per class, intersected with nothing: a rule never
      // claims an outcome its class forbids.
      outcomes: [...ALLOWED_OUTCOMES[rule.ruleClass]],
    })),
  };
}
