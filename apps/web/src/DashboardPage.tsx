import { useCallback, type ReactNode } from 'react';
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
  return <Overview stats={state.value} />;
}

function Overview({ stats }: { stats: AdminStatsDto }): ReactNode {
  return (
    <Panel title="Overview" action={<span className="muted">{stats.aiMode}</span>}>
      <div className="tiles">
        <Tile label="Requests" value={String(stats.total)} />
        <Tile label="Approved" value={String(stats.byDecision.approved ?? 0)} tone="approved" />
        <Tile label="Denied" value={String(stats.byDecision.denied ?? 0)} tone="denied" />
        <Tile label="Escalated" value={String(stats.byDecision.escalated ?? 0)} tone="escalated" />
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
}: {
  label: string;
  value: string;
  tone?: 'approved' | 'denied' | 'escalated' | 'warn' | undefined;
}): ReactNode {
  return (
    <div className={tone === undefined ? 'tile' : `tile tile-${tone}`}>
      <span className="tile-value">{value}</span>
      <span className="tile-label">{label}</span>
    </div>
  );
}
