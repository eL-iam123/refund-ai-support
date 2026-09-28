import { useCallback, useState, type ReactNode } from 'react';
import type { PolicyDocumentDto, RuleClass } from '@refund/shared';
import { api } from './api';
import { ClassTag, ErrorNote, Loading, OutcomeBadge, Panel } from './components';
import { STAGE_LABEL } from './format';
import { useAsyncData } from './useAsyncData';

/**
 * The rulebook, served by the API from the same `POLICY_RULES` objects the
 * engine evaluates.
 *
 * That is the whole point: this page cannot describe a policy the code does not
 * enforce, because it is generated from the enforcement path. A rule that is
 * not in the table does not run.
 */
export function PolicyPage(): ReactNode {
  const load = useCallback(async () => (await api.policy()).policy, []);
  const state = useAsyncData(load, 'policy');

  if (state.status === 'error') {
    return <ErrorNote error={state.error} />;
  }
  if (state.status === 'loading') {
    return <Loading label="Loading policy…" />;
  }
  return (
    <div className="stack">
      <Precedence policy={state.value} />
      <RuleTable policy={state.value} />
    </div>
  );
}

function Precedence({ policy }: { policy: PolicyDocumentDto }): ReactNode {
  return (
    <Panel title="How a decision is reached" action={<span className="muted">v{policy.version}</span>}>
      <ol className="precedence">
        <li>
          <strong>Deny</strong> wins over everything.{' '}
          <span className="muted">precedence {policy.precedence.deny}</span>
        </li>
        <li>
          Then <strong>escalate</strong>.{' '}
          <span className="muted">precedence {policy.precedence.escalate}</span>
        </li>
        <li>
          Then <strong>approve</strong>.{' '}
          <span className="muted">precedence {policy.precedence.approve}</span>
        </li>
      </ol>
      <p>
        A request no rule concludes escalates rather than approving. An item-scoped denial only
        removes that item from the basket; it cannot refuse the whole request on its own.
      </p>
      <h3>What each class of rule may conclude</h3>
      <AllowedOutcomes policy={policy} />
      <p className="muted">
        A risk signal may escalate a claim to a human but may never deny it: refusing someone valid
        because they look risky is an unjust refusal, so the restriction is enforced in the engine
        rather than left to each rule's discipline.
      </p>
    </Panel>
  );
}

function AllowedOutcomes({ policy }: { policy: PolicyDocumentDto }): ReactNode {
  return (
    <ul className="allowed">
      {Object.entries(policy.allowedOutcomes).map(([ruleClass, outcomes]) => (
        <li key={ruleClass}>
          <ClassTag ruleClass={ruleClass as RuleClass} />
          {outcomes.map((outcome) => (
            <OutcomeBadge key={outcome} outcome={outcome} />
          ))}
        </li>
      ))}
    </ul>
  );
}

function RuleTable({ policy }: { policy: PolicyDocumentDto }): ReactNode {
  const [query, setQuery] = useState<string>('');
  const rules = policy.rules.filter((rule) => matches(rule.id, rule.title, rule.summary, query));

  return (
    <Panel
      title="Rules"
      action={
        <div className="filters">
          <span className="muted">
            {rules.length} of {policy.rules.length}, in evaluation order
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="filter rules"
            aria-label="filter rules"
          />
        </div>
      }
    >
      <table className="table">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Name</th>
            <th>Class</th>
            <th>Stage</th>
            <th>Scope</th>
            <th>May conclude</th>
            <th>What it does</th>
            <th>Policy</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id}>
              <td className="nowrap">{rule.id}</td>
              <td className="nowrap">{rule.title}</td>
              <td>
                <ClassTag ruleClass={rule.class} />
              </td>
              <td className="nowrap">{STAGE_LABEL[rule.stage]}</td>
              <td className="nowrap">{rule.scope}</td>
              <td>
                {rule.outcomes.map((outcome) => (
                  <OutcomeBadge key={outcome} outcome={outcome} />
                ))}
              </td>
              <td>{rule.summary}</td>
              <td className="muted nowrap">{rule.policyRef}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function matches(id: string, title: string, summary: string, query: string): boolean {
  if (query.trim().length === 0) {
    return true;
  }
  const needle = query.toLowerCase();
  return (
    id.toLowerCase().includes(needle) ||
    title.toLowerCase().includes(needle) ||
    summary.toLowerCase().includes(needle)
  );
}
