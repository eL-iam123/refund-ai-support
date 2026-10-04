import { useCallback, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { RefundRequestDto } from '@refund/shared';
import { api, type RequestDetail } from './api';
import { DecisionBadge, ErrorNote, Loading, Panel } from './components';
import { ModelClaim } from './detail/ModelClaim';
import { FulfilOutcome, OverrideForm } from './detail/OverrideForm';
import { BlockedItems, Overruled } from './detail/Overruled';
import { AuditLog, ModelCalls, Timings } from './detail/Provenance';
import { RuleTrace } from './detail/RuleTrace';
import { formatCents, formatTime } from './format';
import { useAsyncData } from './useAsyncData';

/**
 * The audit drawer: the whole reason to build the thing.
 *
 * Reading top to bottom answers, in order: what did the customer say, what
 * integrity signals fired, what did the model claim, which rules ran, what did
 * the resolver decide, and where a human overruled the resolver. Nothing here
 * is summarised away, because "the policy decided" is only credible if the
 * policy is readable.
 */
export function RequestDetailPage(): ReactNode {
  const { id = '' } = useParams<{ id: string }>();
  // Bumped after an override so the drawer refetches through the normal path,
  // rather than reaching into loaded state by hand.
  const [nonce, setNonce] = useState<number>(0);

  const load = useCallback(async (): Promise<RequestDetail> => api.requestDetail(id), [id]);
  const state = useAsyncData(load, `${id}#${nonce}`);
  const refetch = useCallback(() => setNonce((previous) => previous + 1), []);

  if (state.status === 'error') {
    return <ErrorNote error={state.error} />;
  }
  if (state.status === 'loading') {
    return <Loading label="Loading request…" />;
  }
  return <Drawer detail={state.value} onApplied={refetch} />;
}

function Drawer({ detail, onApplied }: { detail: RequestDetail; onApplied: () => void }): ReactNode {
  const { request } = detail;
  return (
    <div className="drawer">
      <header className="drawer-head">
        <h1>
          <DecisionBadge decision={request.decision.decision} />
          {request.decision.decision === 'approved' || request.decision.decision === 'partial_refund' ? (
            <strong>{formatCents(request.decision.refundAmountCents)}</strong>
          ) : null}
        </h1>
        <p className="muted">
          {request.customerName} · {request.orderId ?? 'no order'} · {formatTime(request.createdAt)} ·{' '}
          <Link to="/admin/requests">back to queue</Link>
        </p>
      </header>

      {request.decision.decision === 'escalated' ? (
        <Panel title="Awaiting a person">
          <p className="muted">
            This request was escalated because the policy could not reach a decision it could stand
            behind. The customer has been told a person is reviewing it. Decide below in the{' '}
            <strong>Human decision</strong> panel — nothing changes for the customer until an agent
            acts, and every act is logged.
          </p>
        </Panel>
      ) : null}

      <Panel title="What the customer said">
        <blockquote className="quote">{request.message}</blockquote>
        <p className="reply-shown">{request.responseText}</p>
      </Panel>

      <IntegritySignals request={request} />
      <ModelClaim request={request} />

      <Panel title="Rules">
        <RuleTrace trace={request.decision.trace} />
      </Panel>

      <Overruled request={request} />
      <BlockedItems request={request} />
      <OverrideForm request={request} onApplied={onApplied} />
      <FulfilOutcome request={request} onFulfilled={onApplied} />

      <div className="two-col">
        <Timings request={request} />
        <ModelCalls calls={detail.llmCalls} />
      </div>

      <AuditLog audit={detail.audit} />
    </div>
  );
}

function IntegritySignals({ request }: { request: RefundRequestDto }): ReactNode {
  if (request.injection.signals.length === 0) {
    return null;
  }
  return (
    <Panel title="Integrity signals">
      <ul className="signals">
        {request.injection.signals.map((signal) => (
          <li key={`${signal.category}-${signal.pattern}`}>
            <span className="tag tag-warn">{signal.category.replace(/_/g, ' ')}</span>
            <code>{signal.matchedText}</code>
            <span className="muted"> matched {signal.pattern}</span>
          </li>
        ))}
      </ul>
      {request.injection.obfuscationNoted ? (
        <p className="muted">Obfuscation markers were present and noted, not acted on.</p>
      ) : null}
    </Panel>
  );
}
