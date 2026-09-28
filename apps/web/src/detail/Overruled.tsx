import type { ReactNode } from 'react';
import type { RefundRequestDto } from '@refund/shared';
import { Panel } from '../components';
import { OVERRIDE_LABEL, formatCents } from '../format';

/**
 * Where the model's proposal lost.
 *
 * This is the panel that answers the skeptical question directly: if the model
 * said yes and the customer was refused, the override record says which rule
 * did it and what the model had proposed. A system that claims the policy is in
 * charge should be willing to show its losses.
 */
export function Overruled({ request }: { request: RefundRequestDto }): ReactNode {
  if (request.decision.overrides.length === 0) {
    return null;
  }
  return (
    <Panel title="Where the model was overruled">
      <ul className="overrides">
        {request.decision.overrides.map((override) => (
          <li key={`${override.code}-${override.detail}`}>
            <span className="tag tag-warn">{OVERRIDE_LABEL[override.code]}</span>
            <span>{override.detail}</span>
            {override.aiProposal === null ? null : (
              <span className="muted">
                model wanted {override.aiProposal.suggestedDecision}{' '}
                {formatCents(override.aiProposal.suggestedAmountCents)} at{' '}
                {override.aiProposal.confidence.toFixed(2)} confidence
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Items a rule pulled out of the basket, with the rule that did it. */
export function BlockedItems({ request }: { request: RefundRequestDto }): ReactNode {
  if (request.decision.blockedItems.length === 0) {
    return null;
  }
  return (
    <Panel title="Items removed from the refund">
      <ul className="blocked">
        {request.decision.blockedItems.map((item) => (
          <li key={item.itemId}>
            <strong>{item.name}</strong> {formatCents(item.priceCents)}
            <span className="rule-chip">{item.ruleId}</span>
            <span className="muted">{item.reason}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
