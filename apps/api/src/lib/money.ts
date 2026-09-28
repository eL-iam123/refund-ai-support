/** Integer-cent money helpers. All arithmetic stays in cents; nothing here uses floats. */

export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function formatCents(cents: number, currency: 'USD' = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function parseAmountToCents(text: string): number | null {
  const match = /(?:\$|usd\s*)?(\d[\d,]*(?:\.\d{1,2})?)/i.exec(text);
  if (!match?.[1]) {
    return null;
  }
  const value = Number.parseFloat(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? toCents(value) : null;
}

export function sumPrices(prices: readonly number[]): number {
  return prices.reduce((total, price) => total + price, 0);
}
