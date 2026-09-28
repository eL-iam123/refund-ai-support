import { useState, type ReactNode } from 'react';
import type { RuleEvaluationDto } from '@refund/shared';
import { ClassTag, OutcomeBadge } from '../components';

/**
 * The rule trace.
 *
 * Passes are collapsed by default: they are the bulk of the trace and rarely
 * the point. The button exists anyway, because "which rules did NOT apply, and
 * why" is a fair question from a reviewer and there is no reason to hide it.
 */
export function RuleTrace({ trace }: { trace: readonly RuleEvaluationDto[] }): ReactNode {
  const [showAll, setShowAll] = useState<boolean>(false);
  const visible = showAll ? trace : trace.filter((entry) => entry.outcome !== 'pass');
  const hidden = trace.length - visible.length;

  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Class</th>
            <th>Outcome</th>
            <th>Evidence</th>
            <th>Policy</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((entry) => (
            <tr
              key={`${entry.ruleId}-${entry.itemIds.join(',')}`}
              className={entry.outcome === 'pass' ? 'muted' : ''}
            >
              <td className="nowrap">{entry.ruleId}</td>
              <td>
                <ClassTag ruleClass={entry.ruleClass} />
              </td>
              <td>
                <OutcomeBadge outcome={entry.outcome} />
              </td>
              <td>
                {entry.evidence}
                {entry.itemIds.length > 0 ? (
                  <span className="muted"> · {entry.itemIds.join(', ')}</span>
                ) : null}
              </td>
              <td className="muted nowrap">{entry.policyRef}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? (
        <button type="button" className="chip" onClick={() => setShowAll(true)}>
          show {hidden} passing rule{hidden === 1 ? '' : 's'}
        </button>
      ) : null}
    </>
  );
}
