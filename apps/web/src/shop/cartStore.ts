/**
 * The cart, held outside React.
 *
 * It is a plain module-level store rather than component state because it has
 * to be readable from two places that are not in the same subtree: the pages
 * that fill it, and the header that shows how many things are in it. Lifting it
 * into a context provider would mean the whole app sat under a provider whose
 * only job was to carry a number to a `<span>`.
 *
 * Nothing here persists. A cart that survived a reload would need to survive
 * against a catalogue that can change underneath it, and re-ordering from the
 * Orders page is one click anyway - so the cart lives as long as the tab.
 */

export interface CartLine {
  readonly productId: string;
  readonly quantity: number;
}

let lines: readonly CartLine[] = [];

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function cartLines(): readonly CartLine[] {
  return lines;
}

export function cartCount(): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function subscribeToCart(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Adds a product, or raises the quantity of the line already holding it. */
export function addToCart(productId: string): void {
  const existing = lines.find((line) => line.productId === productId);
  lines = existing === undefined
    ? [...lines, { productId, quantity: 1 }]
    : lines.map((line) =>
        line.productId === productId ? { ...line, quantity: capped(line.quantity + 1) } : line,
      );
  emit();
}

export function setCartQuantity(productId: string, quantity: number): void {
  if (quantity <= 0) {
    removeFromCart(productId);
    return;
  }
  lines = lines.map((line) => (line.productId === productId ? { ...line, quantity: capped(quantity) } : line));
  emit();
}

export function removeFromCart(productId: string): void {
  lines = lines.filter((line) => line.productId !== productId);
  emit();
}

/**
 * "Buy again" replaces rather than adds.
 *
 * Somebody re-ordering the same thing wants that thing in the cart, not a second
 * copy of what is already there, and the quantities come from the order being
 * re-ordered.
 */
export function refillCart(incoming: readonly CartLine[]): void {
  lines = incoming.map((line) => ({ productId: line.productId, quantity: capped(line.quantity) }));
  emit();
}

export function clearCart(): void {
  lines = [];
  emit();
}

/** The same ceiling the server enforces at checkout, so the UI cannot offer more. */
const MAX_PER_LINE = 10;

function capped(quantity: number): number {
  return Math.min(Math.max(quantity, 1), MAX_PER_LINE);
}
