import type { ReactNode } from 'react';
import type { Decision, RuleClass, RuleOutcome } from '@refund/shared';
import { DECISION_LABEL, OUTCOME_LABEL, RULE_CLASS_LABEL } from './format';

/** Small presentational building blocks shared by the customer and admin views. */

export function DecisionBadge({ decision }: { decision: Decision }): ReactNode {
  return <span className={`badge badge-${decision}`}>{DECISION_LABEL[decision]}</span>;
}

export function OutcomeBadge({ outcome }: { outcome: RuleOutcome }): ReactNode {
  return <span className={`outcome outcome-${outcome}`}>{OUTCOME_LABEL[outcome]}</span>;
}

export function ClassTag({ ruleClass }: { ruleClass: RuleClass }): ReactNode {
  return <span className={`class-tag class-${ruleClass}`}>{RULE_CLASS_LABEL[ruleClass]}</span>;
}

export function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <p className="empty">{children}</p>;
}

export function ErrorNote({ error }: { error: string }): ReactNode {
  return (
    <p className="error-note" role="alert">
      {error}
    </p>
  );
}

export function Loading({ label }: { label: string }): ReactNode {
  return <p className="loading">{label}</p>;
}
