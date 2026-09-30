import { AiUnavailableError, type AgentReply, type AIAnalyzer, type AnalyzerInput, type AttemptObserver } from './analyzer.js';

/**
 * The analyzer used when no provider key is configured.
 *
 * Its whole behaviour is to say it is unavailable, and that is a real behaviour
 * rather than a placeholder. `analyseClaim` in the orchestrator catches
 * `AiUnavailableError`, records "no usable extraction" against the request and
 * carries on with `NO_ANALYSIS` - and `NO_ANALYSIS` is a decision path the
 * resolver already handles on order facts alone, where the absence of a claim can
 * only escalate.
 *
 * That is why a missing key is allowed to start the server. The alternative
 * degradations are worse in ways that are easy to miss:
 *
 *  - Refusing to boot leaves an operator with a dead service and a queue of
 *    customers who cannot even reach a human.
 *  - Silently substituting a pattern matcher looks healthy and is not: it
 *    produces claims that read like a model read the message, so a reviewer
 *    cannot tell degraded from working. This class instead fails the same way a
 *    rate-limited provider fails, which the pipeline, the audit trail and the
 *    admin drawer were all built to show.
 *
 * Each attempt is still reported to the observer, so the reason for the
 * degradation is recorded per request rather than only in a log at boot.
 *
 * `missingKey` becomes the analyzer's model, which is how the degradation names
 * itself in `/api/health`, the admin dashboard and every stored decision. The
 * alternative - a bare "none" - leaves an operator looking at a service that is
 * quietly not answering, rather than at the name of the variable to set.
 */
export function UnavailableAnalyzer(reason: string, missingKey: string): AIAnalyzer {
  const describe = (): string => reason;
  const model = `${missingKey} missing`;
  return {
    label: 'unconfigured',
    model,
    available: false,
    // The reason already names the variable, which is what makes this safe to
    // show a shopper: it is a hint to an operator about their own deployment, not
    // anything about the database.
    unavailableReason: reason,
    analyze(_input: AnalyzerInput, observer: AttemptObserver): Promise<AgentReply> {
      observer({
        model,
        attempt: 1,
        ok: false,
        latencyMs: 0,
        promptTokens: null,
        completionTokens: null,
        error: describe(),
      });
      return Promise.reject(new AiUnavailableError(describe()));
    },
  };
}
