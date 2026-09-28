import { presetFor, type Env } from '../config/env.js';
import { OpenAiAnalyzer } from './openaiAnalyzer.js';
import type { AIAnalyzer } from './analyzer.js';

/**
 * Builds the production analyzer named by the environment.
 *
 * There is no offline branch. The test suite constructs a fake analyzer and
 * passes it in, so the fake lives in `src/test/` where it cannot be reached by
 * a running server.
 */
export function createAnalyzer(env: Env): AIAnalyzer {
  return new OpenAiAnalyzer(env, presetFor(env.AI_PROVIDER));
}

export { OpenAiAnalyzer, modelCandidates, toAnalyzerOrder } from './openaiAnalyzer.js';
export {
  AiUnavailableError,
  type AIAnalyzer,
  type AnalyzerInput,
  type AnalyzerItem,
  type AnalyzerOrder,
  type AnalyzerResult,
  type AttemptObserver,
  type ProviderAttempt,
} from './analyzer.js';
export { parseJson } from './json.js';
export { verifyGrounding } from './grounding.js';
