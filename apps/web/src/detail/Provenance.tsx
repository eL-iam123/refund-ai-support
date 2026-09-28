import type { ReactNode } from 'react';
import type { RefundRequestDto } from '@refund/shared';
import type { LlmCall } from '../api';
import { Empty, Panel } from '../components';
import { STAGE_LABEL, formatTime } from '../format';

/**
 * The provenance trail: what ran, what it cost, what it changed.
 *
 * Stage timings show the pipeline's shape, provider attempts show whether a
 * model was reached and whether it needed a retry, and the audit log is the
 * append-only record a reviewer would read after the fact.
 */
export function Timings({ request }: { request: RefundRequestDto }): ReactNode {
  return (
    <Panel title="Stage timings">
      <ul className="timings">
        {request.timings.map((timing) => (
          <li key={timing.stage}>
            <span className="timing-stage">{STAGE_LABEL[timing.stage]}</span>
            <span className="timing-ms">{timing.durationMs}ms</span>
            <span className="muted">{timing.detail}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function ModelCalls({ calls }: { calls: readonly LlmCall[] }): ReactNode {
  return (
    <Panel title="Model calls">
      {calls.length === 0 ? (
        <Empty>None. The policy answered this one on its own.</Empty>
      ) : (
        <ul className="timings">
          {calls.map((call, index) => (
            <li key={`${call.purpose}-${index}`}>
              <span className="timing-stage">{call.purpose}</span>
              <span className="timing-ms">{call.latencyMs}ms</span>
              <span className="muted">
                {call.model} · attempt {call.attempt} · {call.ok === 1 ? 'ok' : 'failed'}
                {call.promptTokens === null
                  ? ''
                  : ` · ${call.promptTokens}→${call.completionTokens} tokens`}
                {call.error === null ? '' : ` · ${call.error}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function AuditLog({ audit }: { audit: readonly { at: string; kind: string; detail: string }[] }): ReactNode {
  return (
    <Panel title="Audit log">
      <ul className="audit">
        {audit.map((event) => (
          <li key={`${event.at}-${event.kind}`}>
            <span className="muted nowrap">{formatTime(event.at)}</span>
            <span className="rule-chip">{event.kind}</span>
            <span>{event.detail}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
