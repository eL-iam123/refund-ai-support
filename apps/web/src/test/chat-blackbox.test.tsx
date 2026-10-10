import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage, StreamedText } from '../ChatPage';

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
    history: () => ({ orderId: ORDER_ID, closed: false, closedItemIds: [], awaitingPerson: false, turns: [] }),
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

function renderPageWithItem(itemId: string): void {
  render(
    <MemoryRouter initialEntries={[`/help?order=${ORDER_ID}&item=${itemId}`]}>
      <ChatPage />
    </MemoryRouter>,
  );
}

/** Replies stream in, so full-text assertions get room past the default timeout. */
const STREAMED_TEXT_TIMEOUT = { timeout: 5_000 } as const;

describe('ChatPage blackbox', () => {
  it('renders the chat page with order context from the URL', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Get help with an order')).toBeInTheDocument();
    });    expect(screen.getAllByText(/Harbour Stoneware Mug/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Aurora Desk Lamp/).length).toBeGreaterThanOrEqual(1);
  });

  it('arrives with the wizard line already in scope from the URL', async () => {
    // The order page's per-item report deep-links with ?item=: the line the
    // customer picked travels as the message scope, asserted on what is sent
    // rather than on chips - line selection lives on the order page now.
    const user = userEvent.setup();
    renderPageWithItem(MUG_ITEM);
    await user.type(await screen.findByLabelText('Describe the problem'), 'is this covered?');
    await user.click(screen.getByLabelText('Send'));
    await waitFor(() => {
      expect(world.sent).toHaveLength(1);
    });
    expect((world.sent[0]?.body as { itemIds?: readonly string[] } | undefined)?.itemIds).toEqual([MUG_ITEM]);
  });

  it('sends a message and shows the assistant reply', async () => {
    const user = userEvent.setup();
    renderPage();

    const box = await screen.findByLabelText('Describe the problem');
    await user.type(box, 'The mug arrived broken');
    await user.click(screen.getByLabelText('Send'));

    await waitFor(
      () => {
        expect(screen.getByText(/refund of \$24\.00 has been approved/i)).toBeInTheDocument();
      },
      STREAMED_TEXT_TIMEOUT,
    );
    expect(world.sent).toHaveLength(1);
    expect((world.sent[0]?.body as { message: string } | undefined)?.message).toContain('mug arrived broken');
  });

  it('shows the newest reply inside the chat log after sending', async () => {
    const user = userEvent.setup();
    renderPage();

    const box = await screen.findByLabelText('Describe the problem');
    await user.type(box, 'The mug arrived broken');
    await user.click(screen.getByLabelText('Send'));

    await waitFor(
      () => {
        expect(screen.getByText(/refund of \$24\.00 has been approved/i)).toBeInTheDocument();
      },
      STREAMED_TEXT_TIMEOUT,
    );

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

    await waitFor(
      () => {
        expect(screen.getByText(/refund of \$24\.00 has been approved/i)).toBeInTheDocument();
      },
      STREAMED_TEXT_TIMEOUT,
    );
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
    await waitFor(
      () => {
        expect(screen.getByText(/refund of \$24\.00 has been approved/i)).toBeInTheDocument();
      },
      STREAMED_TEXT_TIMEOUT,
    );
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

  it('sends a follow-up while that line is awaiting review', async () => {
    // A line with a person on it stays discussable: the customer is
    // mid-conversation about it, and the scope chips that used to show this
    // are gone, so usability is what the test asserts - the message goes out.
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

    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('Describe the problem'), 'any update on the mug?');
    await user.click(screen.getByLabelText('Send'));
    await waitFor(() => {
      expect(world.sent).toHaveLength(1);
    });
    expect((world.sent[0]?.body as { message?: string } | undefined)?.message).toContain('any update');
  });

  it('drops a deep-linked decided line from the scope', async () => {
    // Decided lines cannot be re-reported: the wizard deep-link may still name
    // one, and the scope filter drops it before anything is sent.
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

    const user = userEvent.setup();
    renderPageWithItem(MUG_ITEM);
    await user.type(await screen.findByLabelText('Describe the problem'), 'checking on my order');
    await user.click(screen.getByLabelText('Send'));
    await waitFor(() => {
      expect(world.sent).toHaveLength(1);
    });
    expect((world.sent[0]?.body as { itemIds?: readonly string[] } | undefined)?.itemIds).toEqual([]);
  });
});

describe('chat comforts', () => {
  function answeredHistory() {
    return {
      orderId: ORDER_ID,
      closed: false,
      closedItemIds: [],
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
        {
          kind: 'request',
          requestId: 'REQ-2',
          message: 'and the lamp?',
          responseText: 'The lamp is covered too.',
          decision: 'approved',
          refundAmountCents: 12_900,
          itemIds: [LAMP_ITEM],
          blockedItems: [],
          createdAt: '2026-01-02T00:01:00.000Z',
        },
      ],
    };
  }

  it('marks the answered message seen and leaves the latest alone', async () => {
    // Two answered turns: only the first sits under an answer, so only it
    // carries the mark. The latest turn has nothing after it - nobody has
    // seen it yet, including the reader.
    world.history = answeredHistory;
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Seen')).toBeInTheDocument();
    });
    expect(screen.getAllByText('Seen')).toHaveLength(1);
  });

  it('shows no mark on a thread nobody has answered', async () => {
    world.history = () => ({ orderId: ORDER_ID, closed: false, closedItemIds: [], awaitingPerson: false, turns: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Get help with an order')).toBeInTheDocument();
    });
    expect(screen.queryByText('Seen')).toBeNull();
  });

  it('copies an answer to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const hadClipboard = 'clipboard' in navigator;
    const previous = (navigator as Navigator & { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      world.history = () => ({
        orderId: ORDER_ID,
        closed: false,
        closedItemIds: [],
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
      // Native dispatch: user-event's hover/press/release sequence races the
      // streaming re-renders in this environment and the press lands on a
      // detached node. The button, handler and clipboard are what's under
      // test, and a real click exercises all three.
      renderPage();
      const btn = await screen.findByLabelText('Copy answer');
      btn.click();
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('Your refund of $24.00 has been approved.');
      });
      expect(screen.getByLabelText('Copied to clipboard')).toBeInTheDocument();
    } finally {
      if (hadClipboard) {
        Object.defineProperty(navigator, 'clipboard', { value: previous, configurable: true });
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    }
  });

  it('casts a verdict on an answer and shows it as cast', async () => {
    world.history = () => ({
      orderId: ORDER_ID,
      closed: false,
      closedItemIds: [],
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
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByLabelText('Helpful answer'));
    expect(screen.getByLabelText('Helpful answer')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(world.requested).toContain('/api/shop/ratings');
    });
  });

  it('types a new reply out instead of popping it in', () => {
    vi.useFakeTimers();
    try {
      const text = 'Your refund of $24.00 has been approved and will arrive shortly.';
      const { container } = render(<StreamedText text={text} stream />);
      expect(container.textContent).not.toBe(text);
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(container.textContent).toBe(text);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders history replies instantly instead of retyping them', () => {
    const text = 'Your refund of $24.00 has been approved.';
    const { container } = render(<StreamedText text={text} stream={false} />);
    expect(container.textContent).toBe(text);
  });
});
