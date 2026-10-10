import { useCallback, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Scenario } from '@refund/shared';
import { api, describe } from './api';
import { DecisionBadge, ErrorNote, Loading, Panel } from './components';
import { formatCents, truncate } from './format';
import { useAsyncData } from './useAsyncData';

/**
 * The scenario catalogue.
 *
 * Each row is a conformance test you can fire at the API by hand: the same
 * fixture that seeds the database, carrying the message and stating what the
 * policy must answer. Sending one is the fastest way to watch a specific rule
 * work, which is why the send button is right there.
 */
/**
 * Fires one scenario at the API and settles its row.
 *
 * The reply is a decision or the assistant's clarifying question. A decision
 * links to the request it created; a question is stated on the row instead,
 * because the fixture asked for a decision and a question is not a fixture
 * result - it is the assistant having found the message ambiguous.
 */
async function runScenario(
  scenario: Scenario,
  setRunning: (update: (previous: readonly { id: string; requestId: string }[]) => readonly { id: string; requestId: string }[]) => void,
): Promise<void> {
  setRunning((previous) => [...previous, { id: scenario.id, requestId: '' }]);
  try {
    const reply = await api.sendMessage({
      customerId: scenario.customer.key,
      orderId: scenario.orderId,
      message: scenario.message,
    });
    if ('question' in reply) {
      setRunning((previous) =>
        previous.map((row) =>
          row.id === scenario.id ? { id: row.id, requestId: `question: ${reply.question}` } : row,
        ),
      );
      return;
    }
    if ('received' in reply) {
      // A thread that is mid-takeover - or parked on an open case - routes the
      // scenario's message to a person instead of the pipeline, so there is no
      // decision row to point at.
      setRunning((previous) =>
        previous.map((row) => (row.id === scenario.id ? { id: row.id, requestId: 'routed to a customer agent' } : row)),
      );
      return;
    }
    const { request } = reply;
    setRunning((previous) =>
      previous.map((row) => (row.id === scenario.id ? { id: row.id, requestId: request.id } : row)),
    );
  } catch (cause: unknown) {
    // Surfaced on the row that failed rather than as a page-level error, so one
    // bad scenario does not hide the other eighteen.
    setRunning((previous) => [...previous, { id: scenario.id, requestId: `error: ${describe(cause)}` }]);
  }
}

export function ScenariosPage(): ReactNode {
  const load = useCallback(async () => (await api.scenarios()).scenarios, []);
  const state = useAsyncData(load, 'scenarios');
  const [running, setRunning] = useState<readonly { id: string; requestId: string }[]>([]);

  const run = useCallback((scenario: Scenario): Promise<void> => runScenario(scenario, setRunning), []);

  if (state.status === 'error') {
    return <ErrorNote error={state.error} />;
  }
  if (state.status === 'loading') {
    return <Loading label="Loading scenarios…" />;
  }
  return (
    <Panel
      title="Scenarios"
      action={<span className="muted">{state.value.length} conformance cases</span>}
    >
      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Case</th>
            <th>Proves</th>
            <th>Message</th>
            <th>Expected</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {state.value.map((scenario) => (
            <ScenarioRow
              key={scenario.id}
              scenario={scenario}
              onRun={run}
              result={running.find((row) => row.id === scenario.id)}
            />
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function RunResult({ requestId, busy }: { requestId: string; busy: boolean }): ReactNode {
  if (busy) {
    return null;
  }
  if (requestId.startsWith('error: ')) {
    return <p className="error-note">{requestId.slice('error: '.length)}</p>;
  }
  if (requestId.startsWith('question: ')) {
    return <p className="muted small">Asked: {requestId.slice('question: '.length)}</p>;
  }
  return (
    <Link to={`/admin/requests/${requestId}`} className="muted">
      last run
    </Link>
  );
}

function ScenarioRow({
  scenario,
  onRun,
  result,
}: {
  scenario: Scenario;
  onRun: (scenario: Scenario) => Promise<void>;
  result: { id: string; requestId: string } | undefined;
}): ReactNode {
  const busy = result !== undefined && result.requestId.length === 0;
  return (
    <tr>
      <td className="nowrap">{scenario.id}</td>
      <td className="nowrap">{scenario.name}</td>
      <td>{scenario.goal}</td>
      <td className="msg-cell">{truncate(scenario.message, 90)}</td>
      <td className="nowrap">
<DecisionBadge decision={scenario.expectedDecision} />
          {scenario.expectedAmountCents > 0 ? formatCents(scenario.expectedAmountCents) : null}
          <div className="muted rule-list">{scenario.expectedRules.join(' ')}</div>
          {scenario.expectsClamp ? <span className="tag tag-warn">expects clamp</span> : null}
      </td>
      <td>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void onRun(scenario);
          }}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
        {result === undefined ? null : <RunResult requestId={result.requestId} busy={busy} />}
      </td>
    </tr>
  );
}
