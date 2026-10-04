import type { ReactNode } from 'react';
import type { RefundRequestDto } from '@refund/shared';
import { Panel } from '../components';
import { formatTime, truncate } from '../format';

/**
 * What the model claimed, and whether its evidence survives checking.
 *
 * The quotes list is the part that matters. A quote the model invented is
 * struck through, and an ungrounded reason cannot approve anything - so the
 * panel shows both the claim and the verdict on the claim.
 */
export function ModelClaim({ request }: { request: RefundRequestDto }): ReactNode {
  return (
    <>
      <IngestNotice request={request} />
      <ClaimBody request={request} />
    </>
  );
}

/**
 * What intake had to do, when it had to do anything.
 *
 * The customer is told this in their reply - "we could not read your message, so a
 * person will" - and the person who has to read it had no way to know. It is the one
 * line that explains an escalation nobody could otherwise account for, so it sits
 * above the claim rather than in a detail panel.
 */
function IngestNotice({ request }: { request: RefundRequestDto }): ReactNode {
  if (request.ingestNotice === null) {
    return null;
  }
  return (
    <Panel title="Why this needed a person">
      <p className="muted">The customer was told:</p>
      <blockquote className="quote">{request.ingestNotice}</blockquote>
      {request.llmCalled ? (
        <p className="note">
          The model was asked and nothing usable came back, so every rule below ran without a
          claim to read.
        </p>
      ) : null}
    </Panel>
  );
}

function ClaimBody({ request }: { request: RefundRequestDto }): ReactNode {
  if (request.extraction === null) {
    return (
      <Panel title="Model claim">
        <p className="empty">
          No extraction.
          {request.llmCalled
            ? ' The model was asked and returned nothing usable, so the decision came from order facts alone.'
            : ' The fact gates ended this before any model was contacted, so the decision came from order facts alone.'}
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Model claim">
      <dl className="kv">
        <dt>Reason</dt>
        <dd>{request.extraction.reason}</dd>
        <dt>Condition</dt>
        <dd>{request.extraction.condition.replace(/_/g, ' ')}</dd>
        <dt>Intent</dt>
        <dd>{request.extraction.intent}</dd>
        <dt>Claimed</dt>
        <dd>
          {request.extraction.claimedAmountCents === null
            ? '—'
            : `$${((request.extraction.claimedAmountCents ?? 0) / 100).toFixed(2)}`}
        </dd>
        <dt>Confidence</dt>
        <dd>{request.extraction.confidence.toFixed(2)}</dd>
        <dt>Language</dt>
        <dd>{request.extraction.language}</dd>
      </dl>
      <p className="muted">Evidence quotes, checked against the customer's own words:</p>
      <ul className="quotes">
        {request.extraction.evidenceQuotes.map((quote) => (
          <li
            key={quote}
            className={request.grounding?.verifiedQuotes.includes(quote) === true ? 'ok' : 'rejected'}
          >
            “{truncate(quote, 140)}”
          </li>
        ))}
      </ul>
      {request.grounding !== null && !request.grounding.grounded ? (
        <p className="note-warn">
          Grounding failed: {request.grounding.rejectedQuotes.length} quote(s) are not in the message,
          so this reason cannot approve anything.
        </p>
      ) : null}
      <p className="muted">Received {formatTime(request.createdAt)}.</p>
    </Panel>
  );
}
