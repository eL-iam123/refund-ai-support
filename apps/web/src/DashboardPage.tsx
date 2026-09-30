import { useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AdminStatsDto } from '@refund/shared';
import { api } from './api';
import { ErrorNote, Loading, Panel } from './components';
import { useAsyncData } from './useAsyncData';

/**
 * The landing numbers.
 *
 * `injectionAttempts` and `clampsFired` sit next to the decision counts on
 * purpose: a system that claims prompt-injection resistance should be showing
 * both how often it was attacked and how often it held.
 */
export function DashboardPage(): ReactNode {
  const load = useCallback(async () => (await api.stats()).stats, []);
  const state = useAsyncData(load, 'stats');

  if (state.status === 'error') {
    return <ErrorNote error={state.error} />;
  }
  if (state.status === 'loading') {
    return <Loading label="Loading stats…" />;
  }
  return (
    <>
      <AiStatusBanner stats={state.value} />
      <Overview stats={state.value} />
    </>
  );
}

/**
 * Whether a model is actually behind this, said where a reviewer will see it.
 *
 * Every other number on this page is a result, and all of them keep arriving
 * perfectly when the model is unreachable - the policy still decides, requests
 * still get answered, the dashboard still fills in. That is the trap: nothing
 * here looks broken, so a deployment can be paying for a model it never reaches
 * and the only evidence is that a lot of requests escalated. This is the one
 * element on the page that reports the health of the thing doing the reading
 * rather than the outcome of the reading.
 */
function AiStatusBanner({ stats }: { stats: AdminStatsDto }): ReactNode {
  if (stats.aiAvailable) {
    return null;
  }
  return (
    <div className="error-note" role="alert">
      <strong>No model is connected.</strong>{' '}
      {stats.aiUnavailableReason ?? 'The configured provider has no API key.'} Requests are not
      being read by a model - they are escalated to a person instead, which is the safe outcome but
      not the one you are paying for. Set the provider key in <code>.env</code> and restart; see
      the Configuration section of the README.
    </div>
  );
}

function Overview({ stats }: { stats: AdminStatsDto }): ReactNode {
  return (
    <Panel title="Overview">
      <div className="tiles">
        <Tile label="Requests" value={String(stats.total)} />
        <Tile label="Approved" value={String(stats.byDecision.approved ?? 0)} tone="approved" />
        <Tile label="Denied" value={String(stats.byDecision.denied ?? 0)} tone="denied" />
        <Tile
          label="Escalated"
          value={String(stats.byDecision.escalated ?? 0)}
          tone="escalated"
          to="/admin/requests?decision=escalated"
        />
        <Tile label="Model calls" value={String(stats.llmCalls)} />
        <Tile label="Override attempts" value={String(stats.injectionAttempts)} tone={tone(stats.injectionAttempts)} />
        <Tile label="Model clamped" value={String(stats.clampsFired)} tone={tone(stats.clampsFired)} />
        <Tile label="Human overrides" value={String(stats.humanOverrides)} />
        <Tile label="Avg pipeline" value={`${stats.averageLatencyMs}ms`} />
      </div>
      <p className="muted">
        <strong>Model clamped</strong> counts requests where the resolver overruled the model's
        proposed decision or amount. It is the metric that shows the policy is actually in charge,
        so it is the one to read next to the override attempts.
      </p>
      <p className="muted">
        <strong>Escalated</strong> is a person's queue, not a number: it links to every request
        awaiting a human decision. Open it, decide, and the tile empties.
      </p>
    </Panel>
  );
}

/** Zero is not interesting; only a non-zero count earns the warning colour. */
function tone(count: number): 'warn' | undefined {
  return count > 0 ? 'warn' : undefined;
}

function Tile({
  label,
  value,
  tone,
  to,
}: {
  label: string;
  value: string;
  tone?: 'approved' | 'denied' | 'escalated' | 'warn' | undefined;
  to?: string;
}): ReactNode {
  const body = (
    <>
      <span className="tile-value">{value}</span>
      <span className="tile-label">{label}</span>
    </>
  );
  const className = tone === undefined ? 'tile' : `tile tile-${tone}`;
  return to === undefined ? (
    <div className={className}>{body}</div>
  ) : (
    <Link className={`${className} tile-link`} to={to}>
      {body}
    </Link>
  );
}
