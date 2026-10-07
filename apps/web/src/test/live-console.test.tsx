import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LiveConversationsPage } from '../LiveConversationsPage';

/**
 * The staff console's live updates.
 *
 * The socket announces arrivals and replies, and the page re-reads on every
 * announcement. That only works while the socket itself is stable: the handler
 * used to be an effect dependency, so every render tore the socket down and
 * rebuilt it, and any message arriving mid-churn landed in storage yet never
 * on screen until a manual refresh. One socket per mount, whatever rerenders.
 */

interface CountingSocket {
  onmessage: (() => void) | null;
  closed: boolean;
}

const sockets: CountingSocket[] = [];

class SocketStub {
  onmessage: (() => void) | null = null;
  closed = false;

  constructor() {
    sockets.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The three shapes `fetch` accepts for a URL, as one string. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubGlobal('WebSocket', SocketStub);
  vi.stubGlobal('fetch', (input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input);
    const path = url.split('?')[0] ?? url;
    if (path === '/api/staff/conversations') {
      return Promise.resolve(json({ conversations: [] }));
    }
    if (path === '/api/staff/analytics') {
      return Promise.resolve(
        json({
          analytics: {
            openHandoffs: 0,
            escalatedAwaiting: 0,
            awaitingReviewCents: 0,
            decisionsToday: {
              approved: 0,
              partial_refund: 0,
              denied: 0,
              escalated: 0,
              exchange: 0,
              store_credit: 0,
            },
            averageTakeoverMinutes: null,
            since: '2026-01-01T00:00:00.000Z',
          },
        }),
      );
    }
    return Promise.resolve(json({ error: 'not_stubbed' }, 404));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the live console socket', () => {
  it('keeps one socket across the rerenders its own messages cause', async () => {
    render(
      <MemoryRouter>
        <LiveConversationsPage />
      </MemoryRouter>,
    );
    await screen.findByText(/Nothing is moving/);
    expect(sockets).toHaveLength(1);

    // A socket announcement re-reads the lists, which rerenders the page.
    // The socket itself must survive that: a resubscribe per render drops
    // whatever arrives between the close and the reopen.
    await act(async () => {
      sockets[0]?.onmessage?.();
      await Promise.resolve();
    });

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closed).toBe(false);
  });
});
