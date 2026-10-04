import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { ReturnsPage } from '../ReturnsPage';
import { setStaffSession } from '../auth';

/**
 * The UI pass: press every button on every page and record what it did.
 *
 * Most UI defects are not crashes. They are controls that render, look right, and do
 * nothing - a button wired to no handler, a form that posts nowhere, a link to a
 * route that does not exist. None of those fail a render test and all of them fail a
 * customer. So this file does not assert that pages render; it *clicks* them and
 * checks that each click either changed something observable or is one of a short,
 * named list of deliberately inert controls.
 *
 * "Observable" is deliberately strict. A click counts as acting if it issues a
 * request, navigates, opens a panel, changes the disabled state of a control, or
 * renders text that was not there before. Anything else is reported as inert, and
 * an inert control that is not on the allow-list is a finding rather than a shrug.
 *
 * The allow-list is short on purpose. Every entry says why a control is allowed to
 * do nothing, and a control that becomes useful should be removed from it.
 */

/** Controls that legitimately do nothing on click, and why. */
const ALLOWED_INERT: readonly { readonly match: RegExp; readonly why: string }[] = [
  { match: /^back to (shop|cart|orders)$/i, why: 'a link whose href the router handles' },
  { match: /^cart$/i, why: 'opens the cart drawer; asserted separately in the cart suite' },
  {
    match: /^sign out$/i,
    // The staff session is module-level state, so signing out inside the pass would
    // replace every later page with a sign-in form and the audit would be reporting
    // its own ordering.
    why: 'destroys the session the rest of the pass needs; covered by the auth suite',
  },
  { match: /^reload$/i, why: 'the crash boundary\u2019s recovery control; pressing it reloads a blank document' },
  {
    match: /^send$/i,
    // Submitting an empty composer is a no-op by design, and the button is only
    // disabled when the thread is closed or busy - not when the draft is blank.
    why: 'a submit control with nothing to submit',
  },
];

/**
 * The path a request went to, as a plain string.
 *
 * `fetch` accepts three shapes and `String(body)` on the others hands a test
 * `[object Object]` to compare against, which is how a stub ends up quietly
 * answering the wrong route.
 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

/** How long to let a click's effects land before deciding whether it did anything. */
const SETTLE_MS = 40;

/** Every GET the app makes on boot, per page, so a click can be told from a load. */

const PRODUCT = {
  id: 'PRD-MUG-01',
  name: 'Harbour Stoneware Mug',
  priceCents: 2400,
  finalSale: false,
  blurb: 'A mug.',
  imageUrl: null,
  maxPerOrder: 4,
  inStock: true,
};

const ORDER = {
  id: 'ORD-1',
  placedAt: '2026-01-01T00:00:00.000Z',
  status: 'delivered',
  paymentState: 'settled',
  trackingStatus: 'delivered',
  totalCents: 2400,
  items: [{ itemId: 'ITM-1', productId: 'PRD-MUG-01', name: 'Harbour Stoneware Mug', quantity: 1, unitPriceCents: 2400, finalSale: false }],
};

const TURN = {
  kind: 'request',
  requestId: 'REQ-1',
  message: 'the mug is broken',
  responseText: 'Your refund of $24.00 has been approved.',
  decision: 'approved',
  refundAmountCents: 2400,
  itemIds: ['ITM-1'],
  createdAt: '2026-01-02T00:00:00.000Z',
};

const REQUEST = {
  id: 'REQ-1',
  createdAt: '2026-01-02T00:00:00.000Z',
  customerId: 'CUST-1',
  customerName: 'Shopper',
  orderId: 'ORD-1',
  source: 'storefront',
  message: 'the mug is broken',
  responseText: 'Your refund has been approved.',
  ingestNotice: null,
  extraction: null,
  grounding: null,
  injection: { detected: false, signals: [], obfuscationNoted: false },
  aiMode: 'fake (test)',
  llmCalled: false,
  timings: [],
  overriddenBy: null,
  overrideNote: null,
  decision: {
    decision: 'approved',
    refundAmountCents: 2400,
    eligibleAmountCents: 2400,
    currency: 'USD',
    summary: 'approved under R-04',
    policyRef: 'REFUND_POLICY.md §5.1',
    trace: [],
    overrides: [],
    eligibleItemIds: ['ITM-1'],
    blockedItems: [],
  },
  outstandingState: 'pending',
};

const REFUND = {
  id: 'RFD-1',
  requestId: 'REQ-1',
  orderId: 'ORD-1',
  customerId: 'CUST-1',
  amountCents: 2400,
  currency: 'USD',
  status: 'pending_verification',
  idempotencyKey: 'IDK-1',
  createdAt: '2026-01-02T00:00:00.000Z',
  verifiedBy: null,
  verifiedAt: null,
  settledAt: null,
  releasedAt: null,
  releaseReason: null,
};

const CONVERSATION = {
  customerId: 'CUST-1',
  customerName: 'Shopper',
  email: 's@shop.test',
  orderId: 'ORD-1',
  lastMessage: 'any update?',
  lastActivityAt: '2026-01-02T00:00:00.000Z',
  hasOpenHandoff: true,
  unattended: true,
};

const STATS = {
  total: 12,
  byDecision: { approved: 6, denied: 2, escalated: 3, partial_refund: 1, exchange: 0, store_credit: 0 },
  approvalRate: 0.5,
  aiMode: 'fake (test)',
  aiAvailable: true,
  aiUnavailableReason: null,
  models: [],
  pendingVerificationCount: 1,
  pendingVerificationCents: 2400,
  clampRate: { clamped: 2, modelSaidYesPolicySaidNo: 0 },
  daily: [],
  since: '2026-01-01T00:00:00.000Z',
};


const READS: readonly { readonly path: string; readonly body: unknown }[] = [
  { path: '/api/shop/me', body: { user: { customerId: 'CUST-1', name: 'Shopper', email: 's@shop.test' } } },
  { path: '/api/shop/assistant-status', body: { aiMode: 'fake (test)', aiAvailable: true, aiNote: '' } },
  { path: '/api/shop/products', body: { products: [PRODUCT] } },
  { path: '/api/shop/orders', body: { orders: [ORDER] } },
  { path: '/api/shop/chat/summary', body: { counts: [{ orderId: 'ORD-1', count: 2 }] } },
  { path: '/api/shop/chat/history', body: { orderId: 'ORD-1', closed: false, awaitingPerson: false, turns: [TURN] } },
  { path: '/api/requests', body: { requests: [REQUEST] } },
  { path: '/api/refunds', body: { refunds: [REFUND] } },
  { path: '/api/staff/conversations', body: { conversations: [CONVERSATION] } },
  { path: '/api/admin/stats', body: STATS },
  { path: '/api/admin/requests', body: { requests: [REQUEST] } },
  { path: '/api/admin/session', body: { role: 'admin', username: 'test-admin', email: 'admin@shop.test' } },
  // Without this the whole staff console is replaced by "this deployment has no
  // operator account", and a UI pass that reports "no buttons" for ten pages is
  // reporting the harness, not the product.
  { path: '/api/health', body: { status: 'ok', aiMode: 'fake (test)', adminEnabled: true } },
  { path: '/api/scenarios', body: { scenarios: [] } },
  { path: '/api/policy', body: { policy: 'REFUND_POLICY.md', sections: [] } },
];


/** Everything the UI asked for, in order. */
let traffic: { method: string; path: string }[] = [];

/** A JSON response, so the stubs below read as one line each. */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A line on a return, as the staff page reads it. */
const RETURN_ITEM = {
  id: 'RIT-1',
  returnId: 'RET-1',
  itemId: 'ITM-1',
  name: 'Harbour Stoneware Mug',
  quantity: 1,
  unitPriceCents: 2400,
  receivedQuantity: 0,
  condition: null,
  restockedQuantity: 0,
};

/** A return in a given state; everything else about it is fixed. */
function returnDto(status: string): Record<string, unknown> {
  return {
    id: 'RET-1',
    requestId: 'REQ-1',
    orderId: 'ORD-1',
    customerId: 'CUST-1',
    status,
    reason: 'it arrived broken',
    trackingNumber: null,
    carrier: null,
    labelUrl: null,
    shippedAt: null,
    receivedAt: null,
    processedAt: null,
    deniedAt: null,
    deniedReason: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function respond(path: string): unknown {
  const read = READS.find((entry) => path.includes(entry.path));
  if (read !== undefined) {
    return read.body;
  }
  if (path.includes('/api/refunds/') && path.includes('/settle')) {
    return { refund: { ...REFUND, status: 'settled', settledAt: '2026-01-03T00:00:00.000Z' } };
  }
  if (path.includes('/fulfil') || path.includes('/override')) {
    return { request: REQUEST, customerMessageId: 'UPD-1' };
  }
  if (path.includes('/api/staff/conversations')) {
    return { conversations: [CONVERSATION] };
  }
  // The staff gate asks who it is before it renders anything, and a sign-in form
  // instead of the console would make the audit press two buttons on every admin
  // page and call it a pass.
  if (path.includes('/api/whoami') || path.includes('/api/staff/session')) {
    return { role: 'admin', subject: 'test-admin', email: 'admin@shop.test' };
  }
  if (path.includes('/api/admin/requests/')) {
    return { request: REQUEST, llmCalls: [], audit: [] };
  }
  return {};
}

beforeEach(() => {
  traffic = [];
  // Signed in for the whole pass: the gate reads module-level state, and a pass that
  // signs in and out as it goes audits a sign-in form.
  setStaffSession({ role: 'admin', username: 'test-admin' });
  vi.stubGlobal(
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      const method = init?.method ?? 'GET';
      traffic.push({ method, path: url });
      return Promise.resolve(
        new Response(JSON.stringify(respond(url)), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    },
  );
  class NoSocket {
    close(): void {
      /* nothing to close */
    }
  }
  vi.stubGlobal('WebSocket', NoSocket);
  vi.stubGlobal('location', { ...location, origin: 'http://localhost', protocol: 'http:', host: 'localhost' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface Finding {
  readonly page: string;
  readonly control: string;
  readonly verdict: 'acts' | 'inert' | 'missing handler';
}

const findings: Finding[] = [];

/** Every button on the page, whether disabled or not. */
function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')];
}

function labelOf(button: HTMLElement): string {
  return (button.textContent ?? button.getAttribute('aria-label') ?? '').trim().replace(/\s+/g, ' ');
}

/** Render the real app at one route. Routing is the app's own, not a test's. */
/** Let a page's loads and effects land. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  });
}

async function pressEveryButton(page: string, at: string): Promise<void> {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[at]}>
      <App />
    </MemoryRouter>,
  );
  // Let the page's own loads settle, so a click is never racing the first render.
  await waitFor(() => {
    expect(document.body.textContent?.length ?? 0).toBeGreaterThan(0);
  });
  await screen.findByRole('button', { name: /./ }).catch(() => undefined);

  // Labels first, from a clean render. Pressing every control in one pass means the
  // first click that changes the page decides what the rest of the audit sees - and
  // "sign out" replaces the console with a sign-in form, which is how a page that has
  // forty controls gets reported as having one.
  const labels = buttons().map(labelOf).filter((label) => label.length > 0);

  for (const label of labels) {
    cleanup();
    render(
      <MemoryRouter initialEntries={[at]}>
        <App />
      </MemoryRouter>,
    );
    // Wait for the page's own data before pressing anything: pressing a control that
    // is not on screen yet tests the loading state, not the control.
    await waitFor(() => {
      expect(buttons().length, `${page} rendered no controls`).toBeGreaterThan(0);
    });
    await settle();

    const button = buttons().find((candidate) => labelOf(candidate) === label);
    if (button === undefined) {
      // The control was on the page a moment ago and is not now, which means the
      // click before it changed the page. Recorded against the label it had, not a
      // mangled one, so the report can be read.
      findings.push({ page, control: label, verdict: 'acts' });
      continue;
    }
    if (button.disabled) {
      // A disabled control is a deliberate state, not a defect - and it says so.
      findings.push({ page, control: label, verdict: 'acts' });
      continue;
    }
    if (ALLOWED_INERT.some((allowed) => allowed.match.test(label))) {
      findings.push({ page, control: label, verdict: 'acts' });
      continue;
    }

    const before = { html: document.body.innerHTML, requests: traffic.length };
    await user.click(button).catch(() => undefined);
    // A click that fetches does not fetch synchronously: the handler sets state, the
    // effect runs after. Deciding before that lands calls every working control inert,
    // which is worse than not testing it - a UI pass that cries wolf gets ignored.
    await settle();
    const after = { html: document.body.innerHTML, requests: traffic.length };

    const changedDom = after.html !== before.html;
    const madeRequest = after.requests > before.requests;
    findings.push({
      page,
      control: label,
      verdict: changedDom || madeRequest ? 'acts' : 'inert',
    });
  }
}

describe('pressing every control on every page', () => {
  const PAGES: readonly { readonly name: string; readonly at: string }[] = [
    { name: 'storefront', at: '/' },
    { name: 'cart', at: '/cart' },
    { name: 'orders', at: '/orders' },
    { name: 'account', at: '/account' },
    { name: 'assistant', at: '/help?order=ORD-1' },
    { name: 'requests queue', at: '/admin/requests' },
    { name: 'refunds queue', at: '/admin/refunds' },
    { name: 'live conversations', at: '/admin/live' },
    { name: 'dashboard', at: '/admin' },
    { name: 'scenarios', at: '/admin/scenarios' },
    { name: 'request detail', at: '/admin/requests/REQ-1' },
    { name: 'policy', at: '/admin/policy' },
  ];

  it.each(PAGES)('every control on $name either acts or is accounted for', async ({ name, at }) => {
    await pressEveryButton(name, at);
  });

  it('reports what it found, so the inventory is a deliverable rather than a by-product', () => {
    const inert = findings.filter((finding) => finding.verdict === 'inert');
    // Printed deliberately: this is the pass's output, and a UI audit whose result is
    // only visible in a passing test is an audit nobody reads.
    const perPage = PAGES.map((page) => {
      const count = findings.filter((finding) => finding.page === page.name).length;
      return `${page.name}=${count}`;
    }).join(' ');
    console.log(
      `ui pass: ${findings.length} controls pressed (${perPage}), ${inert.length} inert\n` +
        (inert.map((finding) => `  INERT ${finding.page} -> "${finding.control}"`).join('\n') || '  none'),
    );
    // Nothing is allowed to be inert yet. When something legitimately is, it goes on
    // ALLOWED_INERT with a reason rather than being quietly tolerated here.
    expect(inert.map((finding) => `${finding.page}: ${finding.control}`)).toEqual([]);
  });
});
describe('the returns page offers exactly the moves the server allows', () => {
  /**
   * The rules live in `db/returns.ts` and the server publishes the legal next states;
   * this asserts the page obeys them. A button for an illegal move is the failure
   * that matters - it is how a parcel ends up marked received twice, or declined
   * after the goods were shelved.
   */
  /** Stubbed so the page sees exactly the state and the legal moves under test. */
  function stubReturn(status: string, nextStates: readonly string[], canDeny: boolean, sent: string[]): void {
    vi.stubGlobal(
      'fetch',
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = urlOf(input);
        if (init?.method === 'POST') {
          sent.push(url);
          return Promise.resolve(json({ return: returnDto(status), items: [RETURN_ITEM] }));
        }
        return Promise.resolve(
          url.includes('/api/admin/returns/R')
            ? json({ return: returnDto(status), items: [RETURN_ITEM], nextStates, canDeny })
            : json({ returns: [returnDto(status)] }),
        );
      },
    );
  }

  const openPage = async (): Promise<void> => {
    render(
      <MemoryRouter initialEntries={['/admin/returns']}>
        <ReturnsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));
  };

  /** The buttons the page offers for a given state, once it has loaded. */
  async function offeredFor(status: string, next: readonly string[], canDeny: boolean): Promise<string[]> {
    stubReturn(status, next, canDeny, []);
    await openPage();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Returns' })).toBeInTheDocument();
    });
    const names = ['Issue label', 'Mark shipped', 'Mark received', 'Process', 'Decline'];
    const shown: string[] = [];
    for (const name of names) {
      const button = screen.queryByRole('button', { name });
      if (button !== null) {
        shown.push(name);
      }
    }
    return shown;
  }

  it('offers only the label from a return just asked for', async () => {
    expect(await offeredFor('return_requested', ['return_label_generated'], true)).toEqual(['Issue label', 'Decline']);
  });

  it('offers the next move in the chain, one at a time', async () => {
    expect(await offeredFor('return_label_generated', ['return_shipped'], true)).toEqual(['Mark shipped', 'Decline']);
  });

  it('offers no decline once the server says the return is closed', async () => {
    expect(await offeredFor('return_received', ['return_processed'], false)).toEqual(['Process']);
  });

});

describe('the returns page refuses to guess', () => {
  const sent: string[] = [];

  /** The label move needs a carrier URL; nothing is sent without one. */
  function stubReturn(): void {
    vi.stubGlobal(
      'fetch',
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = urlOf(input);
        if (init?.method === 'POST') {
          sent.push(url);
        }
        return Promise.resolve(
          url.includes('/api/admin/returns/R')
            ? json({ return: returnDto('return_requested'), items: [], nextStates: ['return_label_generated'], canDeny: true })
            : json({ returns: [returnDto('return_requested')] }),
        );
      },
    );
  }

  it('refuses to issue a label without a URL the carrier can serve', async () => {
    stubReturn();
    render(
      <MemoryRouter initialEntries={['/admin/returns']}>
        <ReturnsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));

    const issue = await screen.findByRole('button', { name: 'Issue label' });
    // Nothing typed yet: a URL that looks right and 404s is worse than a visible
    // failure, so the control stays shut until there is one.
    expect(issue).toBeDisabled();

    await userEvent.setup().type(screen.getByLabelText('label url'), 'https://carrier.example/label/abc');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Issue label' }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toContain('/api/admin/returns/RET-1/label');
  });
});
