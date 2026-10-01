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
    <>
      <section className="console-intro">
        <div>
          <p className="eyebrow">Refund support operations</p>
          <h1>Overview</h1>
          <p className="lede">Review customer issues, monitor escalations, and keep policy decisions lined up with the written rules.</p>
        </div>
        <span className="console-status"><span aria-hidden="true" />Support resolver online</span>
      </section>
      <Panel title="Support queue health" action={<Link className="panel-action" to="/admin/requests?decision=escalated">Review escalated cases</Link>}>
        <div className="tiles tiles-primary">
          <Tile
            label="Escalated"
            value={String(stats.byDecision.escalated ?? 0)}
            tone="escalated"
            to="/admin/requests?decision=escalated"
          />
          <Tile label="Total requests" value={String(stats.total)} />
          <Tile label="Approved" value={String(stats.byDecision.approved ?? 0)} tone="approved" />
          <Tile label="Denied" value={String(stats.byDecision.denied ?? 0)} tone="denied" />
        </div>
        <div className="system-metrics" aria-label="System metrics">
          <Metric label="Model calls" value={String(stats.llmCalls)} />
          <Metric label="Overrides attempted" value={String(stats.injectionAttempts)} tone={tone(stats.injectionAttempts)} />
          <Metric label="Resolver corrections" value={String(stats.clampsFired)} tone={tone(stats.clampsFired)} />
          <Metric label="Human overrides" value={String(stats.humanOverrides)} />
          <Metric label="Average pipeline" value={`${stats.averageLatencyMs}ms`} />
        </div>
      </Panel>
    </>
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

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'warn' | undefined }): ReactNode {
  return (
    <div className={tone === 'warn' ? 'system-metric metric-warn' : 'system-metric'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
