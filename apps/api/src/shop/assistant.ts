import { randomUUID } from 'node:crypto';
import type { ShopAnswerDto } from '@refund/shared';
import type { Db } from '../db/connection.js';
import { findOrder } from '../db/orderRepository.js';
import type { OrderRecord } from '../db/records.js';
import {
  recordShopTurn,
  type ShopAnswerRecord,
  type ShopCard,
  type ShopOrderSnapshot,
  type ShopTurn,
} from '../db/shopAssistant.js';
import type { PipelineDeps } from '../orchestrator.js';
import type { Identification } from '../retrieval/identifyOrder.js';
import { findProduct, listProducts, type Product } from './catalogue.js';
import { searchProducts } from '../retrieval/catalogSearch.js';
import { MAX_SHOP_PRODUCTS } from '../ai/schemas.js';
import { GeneralReplySchema } from '../ai/schemas.js';
import { isSafeGeneralReply } from '../ai/replyGuard.js';
import type { DialogueLine, ProviderAttempt, ShopProduct } from '../ai/analyzer.js';
import { POLICY_RULES } from '../policy/rules/index.js';
import { listShopTurns } from '../db/shopAssistant.js';
import { inferTone } from '../response/tone.js';
import { classifyShopIntent } from '../response/shopIntent.js';
import { fallbackGeneralAnswer, greetingAnswer, productAnswer, returnHelpAnswer, statusAnswer } from '../response/shopCompose.js';

/**
 * The shopping assistant: order status, return logistics, product browsing.
 *
 * Returns null for anything that could be a refund claim, and the caller runs
 * the refund pipeline instead. That null is the safety property: this module
 * writes `shop_assistant_turns` rows and nothing else, so a message handled
 * here can never become a decision, a reservation, or an audit event.
 */

/** How many catalogue rows the model may rank. Bounded so the prompt cannot grow with the shop. */
const MAX_CATALOG_PRODUCTS = 50;

/** How many recent turns set the tone and ground the conversation. Bounded like every loop. */
const MAX_GENERAL_HISTORY = 10;

export interface ShopTurnRequest {
  readonly customerId: string;
  readonly orderId: string | null;
  readonly message: string;
  readonly shoppingMode: boolean;
  readonly identification: Identification;
  readonly now: Date;
}

export async function answerShopTurn(
  db: Db,
  pipeline: PipelineDeps,
  input: ShopTurnRequest,
): Promise<ShopTurn | null> {
  const intent = classifyShopIntent(input.message, input.shoppingMode);
  if (intent === 'refund') {
    return null;
  }
  // Generated here so model-attempt rows recorded mid-answer name the turn
  // they belong to before it is inserted.
  const turnId = `SHOP-${randomUUID()}`;
  if (intent === 'order_status') {
    return statusTurn(db, input, turnId);
  }
  if (intent === 'return_help') {
    return persist(db, input, turnId, {
      kind: 'return_help',
      answer: returnHelpAnswer(),
      products: [],
      orderStatus: null,
    });
  }
  if (intent === 'greeting') {
    return persist(db, input, turnId, {
      kind: 'general',
      answer: greetingAnswer(input.message),
      products: [],
      orderStatus: null,
    });
  }
  if (intent === 'general') {
    return generalTurn(db, pipeline, input, turnId);
  }
  return productTurn(db, pipeline, input, turnId);
}

/**
 * An order-status answer, or null when no order of this customer is in view.
 *
 * Null falls through to the refund pipeline, which asks which order is meant:
 * guessing an order here would attach facts about one basket to a question
 * about another.
 */
function statusTurn(db: Db, input: ShopTurnRequest, turnId: string): ShopTurn | null {
  const orderId = input.orderId ?? input.identification.order?.id ?? null;
  if (orderId === null) {
    return null;
  }
  const order = findOrder(db, input.customerId, orderId, input.now);
  if (order === null) {
    return null;
  }
  return persist(db, input, turnId, {
    kind: 'order_status',
    answer: statusAnswer(order),
    products: [],
    orderStatus: snapshotOf(order),
  });
}

function snapshotOf(order: OrderRecord): ShopOrderSnapshot {
  return {
    orderId: order.id,
    status: order.status,
    paymentState: order.paymentState,
    trackingStatus: order.trackingStatus,
    totalCents: order.totalCents,
    items: order.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    })),
  };
}

/**
 * A product answer: model nominations first, keyword search as the fallback.
 *
 * Nominated ids are re-resolved against the database and anything unknown is
 * dropped, so the model narrows what is shown and never invents it. When the
 * model is absent, fails, or nominates nothing usable, the FTS index answers
 * instead - which is also what serves deployments with no key at all.
 */
async function productTurn(db: Db, pipeline: PipelineDeps, input: ShopTurnRequest, turnId: string): Promise<ShopTurn> {
  const fallback = searchProducts(db, {
    query: input.message,
    inStockOnly: false,
    maxPriceCents: null,
    limit: MAX_SHOP_PRODUCTS,
    match: 'any',
  });
  const nominated = await nominateProducts(db, pipeline, input, turnId);
  const resolved = resolveProducts(db, nominated);
  const products = resolved.length > 0 ? resolved : fallback;
  return persist(db, input, turnId, {
    kind: 'product_help',
    answer: productAnswer(products),
    products: products.map(toCard),
    orderStatus: null,
  });
}

function toCard(item: Product): ShopCard {
  return { id: item.id, name: item.name, priceCents: item.priceCents, stock: item.stock };
}

/**
 * A general answer: the model talks, the guardrails listen.
 *
 * The model gets public context and a tone hint; its prose is schema-checked
 * and guard-checked before anyone reads it. Anything else - no model, a
 * failure, an unsafe sentence - falls back to the deterministic answer, which
 * is why a general question works with no key at all.
 */
async function generalTurn(db: Db, pipeline: PipelineDeps, input: ShopTurnRequest, turnId: string): Promise<ShopTurn> {
  const history = recentDialogue(db, input.customerId);
  const answer = (await converseBounded(db, pipeline, input, history, turnId)) ?? fallbackGeneralAnswer();
  return persist(db, input, turnId, {
    kind: 'general',
    answer,
    products: [],
    orderStatus: null,
  });
}

/** The customer's shopping thread as model context, oldest first. */
function recentDialogue(db: Db, customerId: string): readonly DialogueLine[] {
  return listShopTurns(db, customerId, MAX_GENERAL_HISTORY).flatMap((turn) => [
    { role: 'customer' as const, text: turn.customerMessage },
    { role: 'assistant' as const, text: turn.record.answer },
  ]);
}

async function converseBounded(
  db: Db,
  pipeline: PipelineDeps,
  input: ShopTurnRequest,
  history: readonly DialogueLine[],
  turnId: string,
): Promise<string | null> {
  if (pipeline.analyzer.converse === undefined) {
    return null;
  }
  const profile = inferTone(history);
  const catalogue = listProducts(db)
    .slice(0, MAX_CATALOG_PRODUCTS)
    .map((item) => ({ name: item.name }));
  const policy = POLICY_RULES.map((rule) => ({ title: rule.title, summary: rule.summary }));
  const observer = (attempt: ProviderAttempt): void => {
    pipeline.recordAttempt(turnId, pipeline.analyzer.label, attempt);
  };
  try {
    const text = await pipeline.analyzer.converse(
      { message: input.message, history, products: catalogue, policy, style: { tone: profile.tone } },
      observer,
    );
    if (text === null) {
      return null;
    }
    const parsed = GeneralReplySchema.safeParse(text);
    if (!parsed.success || !isSafeGeneralReply(parsed.data)) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/** Ids the model nominated, or null when there is no model to ask or it declined. */
async function nominateProducts(
  db: Db,
  pipeline: PipelineDeps,
  input: ShopTurnRequest,
  turnId: string,
): Promise<readonly string[] | null> {
  if (pipeline.analyzer.suggestProducts === undefined) {
    return null;
  }
  const catalogue: readonly ShopProduct[] = listProducts(db)
    .slice(0, MAX_CATALOG_PRODUCTS)
    .map((item) => ({ id: item.id, name: item.name, priceCents: item.priceCents }));
  const observer = (attempt: ProviderAttempt): void => {
    pipeline.recordAttempt(turnId, pipeline.analyzer.label, attempt);
  };
  // The optional call keeps the analyzer as the receiver: detaching the method
  // first would call it with no `this` and crash on `this.env`.
  try {
    const suggestion = await pipeline.analyzer.suggestProducts(
      { message: input.message, history: [], products: catalogue },
      observer,
    );
    return suggestion === null ? null : suggestion.productIds;
  } catch {
    return null;
  }
}

/** Re-resolves nominated ids against the catalogue, dropping what is not there. */
function resolveProducts(db: Db, nominated: readonly string[] | null): readonly Product[] {
  if (nominated === null) {
    return [];
  }
  const products: Product[] = [];
  for (const id of nominated.slice(0, MAX_SHOP_PRODUCTS)) {
    const found = findProduct(db, id);
    if (found !== null) {
      products.push(found);
    }
  }
  return products;
}

function persist(db: Db, input: ShopTurnRequest, turnId: string, record: ShopAnswerRecord): ShopTurn {
  return recordShopTurn(db, {
    id: turnId,
    customerId: input.customerId,
    // The thread the question was asked on, not the order it happened to
    // match: a browsing question that names a product the customer owns is
    // still browsing, and filing it under that order would replay it on the
    // wrong thread after a reload while hiding it from the shopping one.
    orderId: input.orderId,
    customerMessage: input.message,
    record,
    now: input.now,
  });
}

/**
 * The persisted turn as the customer reads it, field by field.
 *
 * Explicit rather than spread: a column added to the record must not reach a
 * browser by accident, and a field the contract dropped must fail here at
 * compile time rather than arrive as `undefined` in a bubble.
 */
export function toShopAnswer(turn: ShopTurn): ShopAnswerDto {
  return {
    id: turn.id,
    kind: turn.record.kind,
    answer: turn.record.answer,
    products: turn.record.products.map((card) => ({
      id: card.id,
      name: card.name,
      priceCents: card.priceCents,
      stock: card.stock,
    })),
    orderStatus: turn.record.orderStatus,
    orderId: turn.orderId,
    createdAt: turn.createdAt,
  };
}
