import { presetFor, type Env } from '../config/env.js';
import { OpenAiAnalyzer } from './openaiAnalyzer.js';
import { AnthropicAnalyzer } from './anthropicAnalyzer.js';
import { LocalAnalyzer } from './localAnalyzer.js';
import { UnavailableAnalyzer } from './unavailableAnalyzer.js';
import type { AIAnalyzer } from './analyzer.js';

/**
 * Builds the analyzer the environment names.
 *
 * Three wire formats, so three adapters, chosen by the preset rather than sniffed
 * at runtime: the OpenAI-compatible shape most vendors expose, Anthropic's own
 * Messages API, and the no-network local matcher.
 *
 * A missing key does not throw. It builds an analyzer whose only behaviour is to
 * report itself unavailable, and the pipeline already treats "no usable claim" as
 * "decide it without one" - which escalates. So a misconfigured key costs the
 * requests their explanations and sends them to a person, which is the correct
 * place for them, and leaves the product running. The alternative - refusing to
 * boot - means an operator fixing a key has nothing to queue in the meantime.
 */
export function createAnalyzer(env: Env): AIAnalyzer {
  const preset = presetFor(env.AI_PROVIDER);

  if (preset.kind === 'local') {
    return LocalAnalyzer();
  }

  const apiKeyEnv = preset.apiKeyEnv;
  if (apiKeyEnv === null) {
    // Unreachable while `local` is the only keyless preset and it is handled
    // above. Guarded rather than asserted, so a future keyless provider fails
    // with something readable instead of reading `null` as a variable name.
    throw new Error(`provider ${preset.label} has no API key variable configured`);
  }

  const apiKey = env[apiKeyEnv];
  if (apiKey === undefined) {
    return UnavailableAnalyzer(`${apiKeyEnv} is not set, so no claim can be extracted`, apiKeyEnv);
  }

  return preset.kind === 'anthropic'
    ? new AnthropicAnalyzer(env, preset, apiKey)
    : new OpenAiAnalyzer(env, preset, apiKey);
}

export { OpenAiAnalyzer } from './openaiAnalyzer.js';
export { AnthropicAnalyzer } from './anthropicAnalyzer.js';
export { LocalAnalyzer } from './localAnalyzer.js';
export { UnavailableAnalyzer } from './unavailableAnalyzer.js';
export { modelCandidates, toAnalyzerOrder } from './openaiAnalyzer.js';
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
