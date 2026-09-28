import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CustomerDto, OrderDto, RefundRequestDto } from '@refund/shared';
import { DecisionBadge, ErrorNote, Loading } from './components';
import { formatCents, formatTime } from './format';
import { useConversation, type Turn } from './useConversation';
import { useOrderPicker, type OrderPicker } from './useOrderPicker';

/**
 * The customer-facing surface.
 *
 * Deliberately shows only the reply, the decision and the amount. The rule
 * trace, the model output and the injection signals live in the admin drawer -
 * a customer does not need to read a rulebook to be told no, and showing them
 * the machinery would only invite them to argue with it.
 */

const GREETING =
  'Hi. Tell me what went wrong with your order and I will check what our refund policy allows.';

export function ChatPage(): ReactNode {
  const picker = useOrderPicker();
  const chat = useConversation(picker.customerId, picker.order?.id ?? null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log !== null) {
      log.scrollTop = log.scrollHeight;
    }
  }, [chat.turns]);

  return (
    <div className="chat-layout">
      <aside className="chat-context">
        <h2>Acting as</h2>
        <ContextPanel picker={picker} />
      </aside>

      <section className="chat-main">
        <div className="chat-log" ref={logRef}>
          <div className="bubble bubble-them">{GREETING}</div>
          {chat.turns.map((turn) => (
            <TurnView key={turn.id} turn={turn} />
          ))}
        </div>
        <Composer draft={chat.draft} busy={chat.busy} onDraft={chat.setDraft} onSend={chat.send} />
        {chat.error.length > 0 ? <ErrorNote error={chat.error} /> : null}
      </section>
    </div>
  );
}

/** The customer picker, order picker and the facts the policy will read. */
function ContextPanel({ picker }: { picker: OrderPicker }): ReactNode {
  if (picker.customers.status === 'error') {
    return <ErrorNote error={picker.customers.error} />;
  }
  if (picker.customers.status === 'loading') {
    return <Loading label="Loading customers…" />;
  }
  return (
    <ContextPicker
      customers={picker.customers.value}
      customerId={picker.customerId}
      orders={picker.orders.status === 'ready' ? picker.orders.value : []}
      orderId={picker.order?.id ?? ''}
      onCustomer={picker.selectCustomer}
      onOrder={picker.selectOrder}
    />
  );
}

function ContextPicker({
  customers,
  customerId,
  orders,
  orderId,
  onCustomer,
  onOrder,
}: {
  customers: readonly CustomerDto[];
  customerId: string;
  orders: readonly OrderDto[];
  orderId: string;
  onCustomer: (next: string) => void;
  onOrder: (next: string) => void;
}): ReactNode {
  return (
    <>
      <label>
        Customer
        <select value={customerId} onChange={(event) => onCustomer(event.target.value)}>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name} — {customer.tier}
            </option>
          ))}
        </select>
      </label>

      <label>
        Order
        <select value={orderId} onChange={(event) => onOrder(event.target.value)}>
          {orders.length === 0 ? <option value="">no orders</option> : null}
          {orders.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.id} — {formatCents(candidate.totalCents)}
            </option>
          ))}
        </select>
      </label>

      <OrderFacts order={orders.find((candidate) => candidate.id === orderId)} />
    </>
  );
}

function Composer({
  draft,
  busy,
  onDraft,
  onSend,
}: {
  draft: string;
  busy: boolean;
  onDraft: (next: string) => void;
  onSend: () => Promise<void>;
}): ReactNode {
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void onSend();
      }}
    >
      <input
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        placeholder="The mug arrived with a crack through the handle…"
        maxLength={4000}
        aria-label="your message"
      />
      <button type="submit" disabled={busy || draft.trim().length === 0}>
        {busy ? 'Working…' : 'Send'}
      </button>
    </form>
  );
}

function TurnView({ turn }: { turn: Turn }): ReactNode {
  return (
    <div className="exchange">
      <div className="bubble bubble-me">{turn.text}</div>
      {turn.kind === 'pending' ? (
        <div className="bubble bubble-them bubble-pending">checking the policy…</div>
      ) : null}
      {turn.kind === 'replied' ? <Reply result={turn.result} /> : null}
    </div>
  );
}

function Reply({ result }: { result: RefundRequestDto }): ReactNode {
  return (
    <div className="bubble bubble-them">
      <p>{result.responseText}</p>
      <footer className="reply-foot">
        <DecisionBadge decision={result.decision.decision} />
        {result.decision.decision !== 'denied' ? (
          <strong>{formatCents(result.decision.refundAmountCents)}</strong>
        ) : null}
        <span className="muted" title={result.decision.policyRef}>
          {result.decision.policyRef}
        </span>
        <span className="muted">{formatTime(result.createdAt)}</span>
        <Link to={`/admin/requests/${result.id}`} className="muted">
          why?
        </Link>
      </footer>
    </div>
  );
}

function OrderFacts({ order }: { order: OrderDto | undefined }): ReactNode {
  if (order === undefined) {
    return null;
  }
  return (
    <div className="facts">
      <h3>Order facts</h3>
      <dl>
        <dt>Total</dt>
        <dd>{formatCents(order.totalCents)}</dd>
        <dt>Placed</dt>
        <dd>{formatTime(order.placedAt)}</dd>
        <dt>Status</dt>
        <dd>{order.status.replace(/_/g, ' ')}</dd>
        <dt>Payment</dt>
        <dd>{order.paymentState.replace(/_/g, ' ')}</dd>
      </dl>
      <ul>
        {order.items.map((item) => (
          <li key={item.id}>
            {item.name}
            {item.finalSale ? <span className="tag">final sale</span> : null}
            {item.digital && item.downloaded ? <span className="tag">consumed</span> : null}
            <span className="muted"> {formatCents(item.unitPriceCents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
