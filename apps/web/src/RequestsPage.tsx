import { useCallback, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Decision, RefundRequestSummaryDto } from '@refund/shared';
import { api } from './api';
import { DecisionBadge, Empty, ErrorNote, Loading, Panel } from './components';
import { formatCents, formatTime, truncate } from './format';
import { useAsyncData } from './useAsyncData';

/**
 * The request queue.
 *
 * `reasonCodes` is the deciding rules, not every rule that ran: an operator
 * scanning a queue needs "why", and the full pass trail belongs in the drawer.
 */

const FILTERS: readonly { value: Decision | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'approved', label: 'Approved' },
  { value: 'denied', label: 'Denied' },
  { value: 'escalated', label: 'Escalated' },
];

export function RequestsPage(): ReactNode {
  const [filter, setFilter] = useState<Decision | ''>('');
  const [search, setSearch] = useState<string>('');

  const load = useCallback(
    () => api.listRequests({ decision: filter || undefined, q: search || undefined }),
    [filter, search],
  );
  const state = useAsyncData(load, `${filter}|${search}`);

  return (
    <Panel title="Requests" action={<Filters filter={filter} search={search} onFilter={setFilter} onSearch={setSearch} />}>
      {state.status === 'error' ? <ErrorNote error={state.error} /> : null}
      {state.status === 'loading' ? <Loading label="Loading requests…" /> : null}
      {state.status === 'ready' && state.value.requests.length === 0 ? (
        <Empty>No requests match this filter.</Empty>
      ) : null}
      {state.status === 'ready' && state.value.requests.length > 0 ? (
        <RequestTable requests={state.value.requests} />
      ) : null}
    </Panel>
  );
}

function Filters({
  filter,
  search,
  onFilter,
  onSearch,
}: {
  filter: Decision | '';
  search: string;
  onFilter: (next: Decision | '') => void;
  onSearch: (next: string) => void;
}): ReactNode {
  return (
    <div className="filters">
      {FILTERS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={filter === option.value ? 'chip chip-on' : 'chip'}
          onClick={() => onFilter(option.value)}
        >
          {option.label}
        </button>
      ))}
      <input
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder="search message, id or order"
        aria-label="search requests"
      />
    </div>
  );
}

function RequestTable({ requests }: { requests: readonly RefundRequestSummaryDto[] }): ReactNode {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>When</th>
          <th>Customer</th>
          <th>Message</th>
          <th>Decision</th>
          <th className="num">Amount</th>
          <th>Decided by</th>
          <th>Model</th>
        </tr>
      </thead>
      <tbody>
        {requests.map((row) => (
          <tr key={row.id}>
            <td className="muted nowrap">{formatTime(row.createdAt)}</td>
            <td className="nowrap">{row.customerName}</td>
            <td>
              <Link to={`/admin/requests/${row.id}`}>{truncate(row.message, 72)}</Link>
              {row.injectionDetected ? <span className="tag tag-warn">override attempt</span> : null}
            </td>
            <td>
              <DecisionBadge decision={row.decision} />
            </td>
            <td className="num">
              {row.decision === 'denied' ? '—' : formatCents(row.refundAmountCents)}
            </td>
            <td>
              {row.reasonCodes.map((code) => (
                <span key={code} className="rule-chip">
                  {code}
                </span>
              ))}
            </td>
            <td className="muted nowrap">
              {row.llmCalled ? 'called' : 'not called'}
              {row.overriddenBy === null ? null : (
                <span className="tag tag-human">by {row.overriddenBy}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
