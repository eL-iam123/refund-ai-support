import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useSearchParams } from 'react-router-dom';
import { OrderDetails } from '../shop/Orders';

/**
 * The per-item report wizard: each line in an order carries its own report
 * state, so finalising one line never buries the others.
 *
 * A closed line shows as finished and offers nothing; an open line offers a
 * report that deep-links into the chat with the line already ticked. The
 * closed set arrives over the chat history, which is the same read the
 * composer uses to decide whether the thread is open at all.
 */

const MUG_ITEM = 'ITM-MUG';
const LAMP_ITEM = 'ITM-LAMP';
const ORDER = {
  id: 'ORD-TEST',
  placedAt: '2026-01-01T00:00:00.000Z',
  status: 'delivered',
  paymentState: 'settled',
  trackingStatus: 'delivered',
  totalCents: 15_300,
  items: [
    { itemId: MUG_ITEM, productId: 'PRD-MUG-01', name: 'Harbour Stoneware Mug', quantity: 1, unitPriceCents: 2_400 },
    { itemId: LAMP_ITEM, productId: 'PRD-LAMP-01', name: 'Aurora Desk Lamp', quantity: 1, unitPriceCents: 12_900 },
  ],
};

let closedItemIds: readonly string[];

/** The three shapes `fetch` accepts for a URL, as one string. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

beforeEach(() => {
  closedItemIds = [MUG_ITEM];
  vi.stubGlobal('fetch', (input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes('/api/shop/chat/history')) {
      return Promise.resolve(
        new Response(JSON.stringify({ orderId: ORDER.id, closed: false, closedItemIds, awaitingPerson: false, turns: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 404 }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Reads back the query the wizard navigated to. */
function HelpProbe(): ReactNode {
  const [params] = useSearchParams();
  return (
    <p>
      {`order=${params.get('order') ?? ''} item=${params.get('item') ?? ''} issue=${params.get('issue') ?? ''}`}
    </p>
  );
}

function renderWizard(): void {
  const router = createMemoryRouter(
    [
      {
        path: '/orders/:id',
        element: <OrderDetails order={ORDER} onBack={() => {}} onReport={() => {}} />,
      },
      { path: '/help', element: <HelpProbe /> },
    ],
    { initialEntries: ['/orders/ORD-TEST'] },
  );
  render(<RouterProvider router={router} />);
}

describe('the per-item report wizard', () => {
  it('shows a closed line as finished and keeps the other line reportable', async () => {
    renderWizard();
    await waitFor(() => {
      expect(screen.getByText('Closed')).toBeInTheDocument();
    });
    const mugRow = screen.getByText('Harbour Stoneware Mug').closest('li') as HTMLElement;
    expect(mugRow.textContent).toContain('Closed');
    expect(mugRow.querySelector('button')).toBeNull();
    const lampRow = screen.getByText('Aurora Desk Lamp').closest('li') as HTMLElement;
    expect(lampRow.querySelector('button')?.textContent).toBe('Report');
  });

  it('reports one line into the chat with the line already named', async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitFor(() => {
      expect(screen.getByText('Aurora Desk Lamp')).toBeInTheDocument();
    });
    const lampRow = screen.getByText('Aurora Desk Lamp').closest('li') as HTMLElement;
    await user.click(lampRow.querySelector('button') as HTMLElement);
    // The picker is scoped to the line, not the order.
    expect(screen.getByText(/what went wrong with Aurora Desk Lamp/i)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Arrived damaged'));
    await user.click(screen.getByText('Continue'));
    await waitFor(() => {
      expect(screen.getByText(`order=ORD-TEST item=${LAMP_ITEM} issue=damaged`)).toBeInTheDocument();
    });
  });
});
