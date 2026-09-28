import type { Db } from './connection.js';
import { insertLlmCall } from './requestRepository.js';
import type { AttemptRecorder } from '../orchestrator.js';

/**
 * Persists every model attempt, successful or not, including the ones that
 * failed and the models that were tried after them. A refund decision that
 * looks deterministic is only trustworthy if you can also see what the model
 * was asked and what it said.
 */
export function createAttemptRecorder(db: Db): AttemptRecorder {
  return (requestId, provider, attempt) => {
    insertLlmCall(db, {
      requestId,
      at: new Date().toISOString(),
      // Only one call exists in the pipeline, so the column is a constant. It
      // stays because this is an audit table: the shape of the log should not
      // change when the code does.
      purpose: 'extraction',
      provider,
      model: attempt.model,
      attempt: attempt.attempt,
      ok: attempt.ok,
      latencyMs: attempt.latencyMs,
      promptTokens: attempt.promptTokens,
      completionTokens: attempt.completionTokens,
      error: attempt.error,
    });
  };
}
