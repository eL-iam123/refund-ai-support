import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '../ChatPage';

const CUSTOMER_ID = 'CUST-TEST';
const ORDER_ID = 'ORD-TEST';
const MUG_ITEM = 'ITM-MUG';
const LAMP_ITEM = 'ITM-LAMP';

const ORDER = {
  id: ORDER_ID,
  placedAt: '2026-01-01T00:00:00.000Z',
  status: 'delivered',
  paymentState: 'settled',
  trackingStatus: 'delivered',
  totalCents: 15_300,
  items: [
    { itemId: MUG_ITEM, productId: 'PRD-MUG-01', name: 'Harbour Stoneware Mug', quantity: 1, unitPriceCents: 2_400, finalSale: false },
    { itemId: LAMP_ITEM, productId: 'PRD-LAMP-01', name: 'Aurora Desk Lamp', quantity: 1, unitPriceCents: 12_900, finalSale: false },
  ],
};

function decidedReply(overrides: Record<string, unknown> = {}): unknown {
  return {
    request: {
      id: 'REQ-TEST',
      createdAt: '2026-01-02T00:00:00.000Z',
      customerId: CUSTOMER_ID,
      customerName: 'Test Shopper',
      orderId: ORDER_ID,
      source: 'storefront',
      message: 'sent',
      responseText: 'Your refund of $24.00 has been approved.',
      extraction: null,
      grounding: null,
      injection: { detected: false, signals: [], obfuscationNoted: false },
      aiMode: 'fake (test)',
      llmCalled: true,
      timings: [],
      overriddenBy: null,
      overrideNote: null,
      decision: {
        decision: 'approved',
        refundAmountCents: 2_400,
        eligibleAmountCents: 2_400,
        currency: 'USD',
        summary: 'Approved under R-04.',
        policyRef: 'REFUND_POLICY.md §5.1',
        trace: [],
        overrides: [],
        eligibleItemIds: [MUG_ITEM],
        blockedItems: [],
        ...overrides,
      },
    },
    notice: null,
  };
}

interface World {
  sent: { url: string; body: unknown }[];
  requested: string[];
  reply: (message: string) => unknown;
  history: () => unknown;
}

let world: World;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const USER = { customerId: CUSTOMER_ID, name: 'Test Shopper', email: 'test@shop.test' };

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const STATIC_ROUTES: ReadonlyMap<string, () => unknown> = new Map<string, () => unknown>([
  ['/api/shop/me', () => ({ user: USER })],
  ['/api/shop/orders', () => ({ orders: [ORDER] })],
  ['/api/shop/chat/summary', () => ({ counts: [{ orderId: ORDER_ID, count: 1 }] })],
  ['/api/health', () => ({ status: 'ok', aiMode: 'fake (test)', adminEnabled: true, aiAvailable: true, aiUnavailableReason: null })],
  ['/api/shop/products', () => ({ products: [] })],
  ['/api/shop/register', () => ({ user: USER })],
  ['/api/shop/login', () => ({ user: USER })],
  ['/api/shop/demo-login', () => ({ user: USER })],
]);

function route(world: World, url: string): Response {
  const path = url.split('?')[0] ?? url;
  if (path === '/api/shop/chat/history') {
    return json(world.history());
  }
  const answer = STATIC_ROUTES.get(path);
  return answer === undefined
    ? json({ error: 'not_stubbed', message: `the test stub has no route for ${path}` }, 404)
    : json(answer());
}

beforeEach(() => {
  world = {
    sent: [],
    requested: [],
    reply: () => decidedReply(),
    history: () => ({ orderId: ORDER_ID, closed: false, awaitingPerson: false, turns: [] }),
  };

  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    world.requested.push(url);

    if (init?.method !== 'POST' || !url.includes('/api/chat/messages')) {
      return Promise.resolve(route(world, url));
    }
    const body = JSON.parse(typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? {})) as { message: string };
    world.sent.push({ url, body });
    return Promise.resolve(json(world.reply(body.message)));
  });

  class NoSocket {
    constructor() { /* deliberately does not connect */ }
    close(): void { /* nothing to close */ }
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onclose: (() => void) | null = null;
  }
  vi.stubGlobal('WebSocket', NoSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={[`/help?order=${ORDER_ID}`]}>
      <ChatPage />
    </MemoryRouter>,
  );
}

describe('ChatPage blackbox', () => {
  it('renders the chat page with order context from the URL', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Get help with an order')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Harbour Stoneware Mug/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Aurora Desk Lamp/).length).toBeGreaterThanOrEqual(1);
  });

  it('sends a message and shows the assistant reply', async () => {
    const user = userEvent.setup();
    renderPage();

    const box = await screen.findByLabelText('Describe the problem');
    await user.type(box, 'The mug arrived broken');
    await user.click(screen.getByLabelText('Send'));

    await waitFor(() => {
      expect(screen.getByText(/refund of \$24\.00 has been approved/i)).toBeInTheDocument();
    });
    expect(world.sent).toHaveLength(1);
    expect((world.sent[0]?.body as { message: string } | undefined)?.message).toContain('mug arrived broken');
  });

  it('shows the newest reply inside the chat log after sending', async () => {
    const user = userEvent.setup();
    renderPage();

    const box = await screen.findByLabelText('Describe the problem');
    await user.type(box, 'The mug arrived broken');
    await user.click(screen.getByLabelText('Send'));

    await waitFor(() => {
      expect(screen.getByText(/refund of \$24\.00 has been approved/i)).toBeInTheDocument();
    });

    const chatLog = document.querySelector('.chat-log');
    expect(chatLog).toBeTruthy();
    if (chatLog) {
      expect(chatLog.textContent).toContain('The mug arrived broken');
      expect(chatLog.textContent).toContain('refund of $24.00 has been approved');
    }
  });

  it('names blocked items in a mixed-cart reply', async () => {
    world.reply = () =>
      decidedReply({
        decision: 'approved',
        refundAmountCents: 2_400,
        eligibleItemIds: [MUG_ITEM],
        blockedItems: [{ name: 'Aurora Desk Lamp', reason: 'final sale' }],
        summary: 'Approved under R-04.',
      });

    const user = userEvent.setup();
    renderPage();

    const box = await screen.findByLabelText('Describe the problem');
    await user.type(box, 'The mug and lamp both arrived damaged');
    await user.click(screen.getByLabelText('Send'));

    await waitFor(() => {
      expect(screen.getByText(/refund of \$24\.00 has been approved/i)).toBeInTheDocument();
    });
    expect(screen.getAllByText(/Aurora Desk Lamp/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/final sale/i)).toBeInTheDocument();
  });

  it('renders a stored turn from history on reload', async () => {
    world.history = () => ({
      orderId: ORDER_ID,
      closed: false,
      awaitingPerson: false,
      turns: [
        {
          kind: 'request',
          requestId: 'REQ-1',
          message: 'The mug arrived broken',
          responseText: 'Your refund of $24.00 has been approved.',
          decision: 'approved',
          refundAmountCents: 2_400,
          itemIds: [MUG_ITEM],
          blockedItems: [],
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });

    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/refund of \$24\.00 has been approved/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/The mug arrived broken/)).toBeInTheDocument();
  });

  it('disables the composer while a person holds the thread', async () => {
    world.history = () => ({
      orderId: ORDER_ID,
      closed: false,
      awaitingPerson: true,
      turns: [],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/someone is picking this up/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Send')).toBeDisabled();
  });

  it('keeps an item chip enabled while that line is awaiting review', async () => {
    world.history = () => ({
      orderId: ORDER_ID,
      closed: false,
      awaitingPerson: false,
      turns: [
        {
          kind: 'request',
          requestId: 'REQ-1',
          message: 'the mug is broken',
          responseText: 'A person is reviewing this request because the reason needs someone to look at the detail.',
          decision: 'escalated',
          refundAmountCents: 0,
          itemIds: [MUG_ITEM],
          blockedItems: [],
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/with a person/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Harbour Stoneware Mug/i })).toBeEnabled();
  });

  it('disables an item chip once that line is decided', async () => {
    world.history = () => ({
      orderId: ORDER_ID,
      closed: false,
      awaitingPerson: false,
      turns: [
        {
          kind: 'request',
          requestId: 'REQ-1',
          message: 'the mug is broken',
          responseText: 'Your refund of $24.00 has been approved.',
          decision: 'approved',
          refundAmountCents: 2_400,
          itemIds: [MUG_ITEM],
          blockedItems: [],
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Harbour Stoneware Mug/i })).toBeDisabled();
    });
  });
});
