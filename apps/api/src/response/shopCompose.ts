import type { OrderRecord } from '../db/records.js';
import type { Product } from '../shop/catalogue.js';
import { formatCents } from '../lib/money.js';

/**
 * Deterministic shopping answers (ADR 0005).
 *
 * Templates over database facts, mirroring `compose.ts` for refunds: the
 * model may choose *which* products are offered, but the words the customer
 * reads are written here. No customer text is echoed, so an injection probe
 * cannot steer the reply, and no figure is stated that was not read from the
 * order or the catalogue row it describes.
 */

/** Where one of the customer's own orders stands, in plain words. */
export function statusAnswer(order: OrderRecord): string {
  const lines = order.items
    .map((item) => `${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ''}`)
    .join(', ');
  return (
    `Your order ${order.id} placed ${order.placedAt.toISOString().slice(0, 10)} is ${order.status.replace(/_/g, ' ')}` +
    ` (${order.trackingStatus.replace(/_/g, ' ')}, payment ${order.paymentState.replace(/_/g, ' ')}).` +
    ` Items: ${lines}.`
  );
}

/** How a parcel gets back to the warehouse. Static: the steps do not vary by order. */
export function returnHelpAnswer(): string {
  return (
    'To send something back, tell me which order and which items in this chat and a person will ' +
    'arrange the return from there. Keep the items unopened where you can - sealed electronics ' +
    'and final-sale items follow different rules, and the refund policy still decides any money.'
  );
}

/** A courtesy for a message that asked for nothing. No model, no row of consequence. */
export function greetingAnswer(message: string): string {
  if (/\bthank\b|\bthanks\b/i.test(message)) {
    return "You're welcome - anything else I can help with, an order, a return, or browsing the catalogue?";
  }
  if (/\bbye\b|\bgoodbye\b|\bgood\s?night\b/i.test(message)) {
    return "Goodbye - I'm here if anything comes up with an order.";
  }
  return 'Hi - what can I help with today? An order, a return, or browsing the catalogue?';
}

/** What a customer without a model behind the assistant still gets told. */
export function fallbackGeneralAnswer(): string {
  return (
    'I can help with orders, returns, refunds, and browsing the catalogue. ' +
    'Tell me what you need - for anything about money, the written refund policy decides, not me.'
  );
}

/** What matched a browsing question, with prices from the catalogue rows. */
export function productAnswer(products: readonly Product[]): string {
  if (products.length === 0) {
    return (
      'I could not find anything in the catalogue matching that. Try different words - a product ' +
      'name or what it is for - and I will look again.'
    );
  }
  const lines = products
    .map(
      (item) =>
        `${item.name} at ${formatCents(item.priceCents)}${item.stock > 0 ? '' : ' (currently out of stock)'}`,
    )
    .join('; ');
  return `Here is what matches: ${lines}. Tap Add on anything to put it in your cart.`;
}
