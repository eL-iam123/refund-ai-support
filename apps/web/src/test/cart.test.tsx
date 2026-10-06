import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { addToCart, clearCart } from '../shop/cartStore';

/**
 * The cart page, driven like a shopper.
 *
 * Two failures shared one root: the page read the cart store once instead of
 * subscribing to it, and there was no way to remove a line at all. So the
 * header count cleared while the row stayed, the checkout button stayed
 * enabled, and pressing it submitted the basket removal had supposedly
 * emptied. Everything here is therefore about what is on screen *and* what
 * goes on the wire after Remove.
 */

const MUG = {
  id: 'PRD-MUG-01',
  name: 'Harbour Stoneware Mug',
  blurb: 'The everyday item',
  description: 'A heavy stoneware mug.',
  priceCents: 2_400,
  finalSale: false,
  digital: false,
  isSubscription: false,
  stock: 150,
  testsPolicy: null,
  imageHue: 160,
};

const USER = { customerId: 'CUST-TEST', name: 'Test Shopper', email: 'test@shop.test' };

interface Sent {
  readonly url: string;
  readonly body: unknown;
}

let sent: Sent[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

beforeEach(() => {
  sent = [];
  clearCart();
  vi.stubGlobal(
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      const path = url.split('?')[0] ?? url;
      if (path === '/api/shop/products') {
        return Promise.resolve(json({ products: [MUG] }));
      }
      if (path === '/api/shop/me') {
        return Promise.resolve(json({ user: USER }));
      }
      if (path === '/api/shop/checkout') {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as unknown;
        sent.push({ url, body });
        return Promise.resolve(
          json({ order: { id: 'ORD-TEST', totalCents: 2_400, trackingStatus: 'delivered' } }),
        );
      }
      return Promise.resolve(json({ error: 'not_stubbed' }, 404));
    },
  );
});

afterEach(() => {
  cleanup();
  clearCart();
  vi.unstubAllGlobals();
});

/** The shop with one mug on sale, then the cart. Add first, then look. */
async function buyMugThenOpenCart(): Promise<void> {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: 'Add to cart' }));
  await user.click(screen.getByRole('link', { name: /cart/i }));
  await screen.findByRole('heading', { name: 'Your cart' });
}

describe('removing the last line', () => {
  it('empties the page, disables checkout, and cannot submit the old basket', async () => {
    const user = userEvent.setup();
    await buyMugThenOpenCart();

    expect(screen.getByText(/harbour stoneware mug/i)).toBeInTheDocument();
    const checkout = screen.getByRole('button', { name: /check out/i });
    expect(checkout).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /Remove Harbour Stoneware Mug/ }));

    expect(await screen.findByText(/your cart is empty/i)).toBeInTheDocument();
    expect(screen.queryByText(/harbour stoneware mug/i)).not.toBeInTheDocument();
    // Disabled, so the click below goes nowhere and the old basket never
    // reaches the server: the order the audit watched being created cannot happen.
    expect(screen.getByRole('button', { name: /check out/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /check out/i }));
    expect(sent).toEqual([]);
  });

  it('checks out what is actually there after a partial removal', async () => {
    const user = userEvent.setup();
    addToCart(MUG.id);
    addToCart('PRD-LAMP-01');
    render(
      <MemoryRouter initialEntries={['/cart']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Your cart' });

    await user.click(screen.getByRole('button', { name: /Remove Harbour Stoneware Mug/ }));
    await user.click(screen.getByRole('button', { name: /check out/i }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toMatchObject({ lines: [{ productId: 'PRD-LAMP-01', quantity: 1 }] });
  });
});
