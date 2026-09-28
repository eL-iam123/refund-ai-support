import { z } from 'zod';
import { INJECTION_ACTIONS } from '@refund/shared';

/**
 * Environment handling. Rule 7: check every return value, and never let a
 * missing key surface later as `undefined` deep inside a request. Everything
 * is validated once, at boot, so a misconfigured deployment fails immediately
 * and loudly instead of at the first customer request.
 */

/**
 * Variables that are optional, but must be non-empty when supplied.
 *
 * `docker compose` passes an unset variable through as an empty string rather
 * than omitting it, so these arrive as `AI_MODEL=''` on a machine that simply has
 * no `.env`. The schema then failed on the empties first and reported
 * "AI_MODEL: Too small" when the actual problem was a missing API key - an error
 * that sends whoever is setting the stack up looking in the wrong place. An empty
 * value means "not supplied", so it is treated as absent here.
 */
const EMPTY_IS_ABSENT = [
  'AI_MODEL',
  'AI_BASE_URL',
  'AI_FALLBACK_MODELS',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'NVIDIA_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

function normaliseEmptyVars(): void {
  for (const key of EMPTY_IS_ABSENT) {
    if (process.env[key] === '') {
      delete process.env[key];
    }
  }
}

/**
 * Published in docker-compose.yml so the stack boots with one command. Rejected
 * at boot in production; see the check in readEnv.
 */
export const PLACEHOLDER_SECRET = 'dev-only-insecure-secret-change-me-0123456789';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_PATH: z.string().min(1).default('./data/refund.sqlite'),
  CORS_ORIGIN: z.string().default('http://localhost:5173,http://localhost:8080'),
  /** Where the built SPA lives. Unset in development, where Vite serves it. */
  WEB_STATIC_DIR: z.string().min(1).optional(),

  /**
   * Which model to use, and how to talk to it.
   *
   * A missing key is no longer a boot failure. The server starts, reports the
   * problem on `/api/health` and in the admin drawer, and every request that
   * needs a claim is decided without one - which can only escalate. That is a
   * better degraded mode than refusing to start, because a product that will not
   * boot cannot queue the requests for a person, and "needs a human" is the only
   * outcome a missing model is allowed to produce.
   *
   * `local` is the deliberate version of the same idea: a pattern matcher, named
   * as one, for running the product and its test scenarios with no credentials.
   * It is refused in production below, so it cannot be the accidental answer to
   * a forgotten key - an absent key degrades to *no claims*, never to *weaker
   * claims that still look like a model read*.
   */
  AI_PROVIDER: z.enum(['groq', 'openrouter', 'openai', 'nvidia', 'gemini', 'anthropic', 'local']).default('groq'),
  /** Overrides the provider's default model when set. */
  AI_MODEL: z.string().min(1).optional(),
  AI_FALLBACK_MODELS: z.string().default(''),
  AI_BASE_URL: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * Wall clock for one whole `analyze()` call: every candidate, every retry and
   * the repair pass together.
   *
   * `AI_TIMEOUT_MS` alone is not a bound, it is a per-request allowance, and the
   * product multiplies it by candidates x attempts x repairs. Without this the
   * server can hold a customer's request open for minutes while it walks a
   * failover list, which is a slow-endpoint problem for a free tier.
   */
  AI_TOTAL_BUDGET_MS: z.coerce.number().int().min(1_000).max(300_000).default(45_000),
  AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(700),
  /**
   * Withhold order facts from the prompt. S-18 is the reason this exists: a model
   * that is shown the order total can produce a "verbatim" quote containing
   * figures the customer never wrote, so the quote check passes and grounding
   * proves nothing. The default is therefore the stronger guarantee - the model
   * sees only the customer's own words - and sharing is an explicit opt-in.
   */
  AI_SHARE_ORDER_FACTS: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  // Uses the shared union so the env contract and R-14 cannot drift apart.
  INJECTION_ACTION: z.enum(INJECTION_ACTIONS).default('deny'),

  /**
   * Caps the customer's message. A refund request is a paragraph, not an upload;
   * without a ceiling a single request can cost an unbounded number of prompt
   * tokens, and the request is stored verbatim before anything looks at it.
   */
  MAX_MESSAGE_LENGTH: z.coerce.number().int().positive().default(4000),
  /**
   * HMAC key for staff tokens. Required and undefaulted on purpose: a server that
   * cannot verify a signature must not fall back to trusting the caller, so
   * startup fails rather than serving an unauthenticated admin API.
   */
  ADMIN_API_SECRET: z.string().min(32, 'ADMIN_API_SECRET must be at least 32 characters'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WINDOW: z.string().min(1).default('1 minute'),
});

export type Env = z.infer<typeof EnvSchema>;

export type AiProvider = Env['AI_PROVIDER'];

export type ProviderApiKeyEnv =
  | 'GROQ_API_KEY'
  | 'OPENROUTER_API_KEY'
  | 'OPENAI_API_KEY'
  | 'NVIDIA_API_KEY'
  | 'GEMINI_API_KEY'
  | 'ANTHROPIC_API_KEY';

/**
 * How a provider is talked to.
 *
 * Most vendors expose an OpenAI-compatible `/chat/completions`, so they share one
 * adapter and differ only by base URL and key. Anthropic does not: its Messages
 * API is a different request shape, a different auth header, and a different way
 * of asking for JSON. Pretending otherwise by pointing the OpenAI client at
 * `api.anthropic.com` produces a 404 that reads like a bad key, which is a
 * genuinely misleading error to hand someone. So the wire format is part of the
 * configuration and picks the adapter.
 */
export type ProviderKind = 'openai_compatible' | 'anthropic' | 'local';

export interface ProviderPreset {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  /** Null only for `local`, which authenticates to nothing. */
  readonly apiKeyEnv: ProviderApiKeyEnv | null;
  readonly label: string;
  /** Used when AI_MODEL is unset, so the common case needs no model config. */
  readonly defaultModel: string;
  /**
   * Sends `response_format: json_object`. Anthropic has no equivalent knob - it
   * gets JSON through a tool call, which its adapter does instead - and the
   * heuristic providers have already proved unreliable with it.
   */
  readonly jsonMode: boolean;
}

const PRESETS: Record<AiProvider, ProviderPreset> = {
  groq: {
    kind: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    label: 'groq',
    defaultModel: 'llama-3.3-70b-versatile',
    jsonMode: true,
  },
  openrouter: {
    kind: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    label: 'openrouter',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    jsonMode: true,
  },
  openai: {
    kind: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    label: 'openai',
    defaultModel: 'gpt-4o-mini',
    jsonMode: true,
  },
  nvidia: {
    // NVIDIA NIM's OpenAI-compatible endpoint. A key from build.nvidia.com; the
    // developer tier is free, and unlike OpenRouter's free router it serves a
    // named model, so a prompt that works keeps working.
    //
    // Two measured facts chose this id. First, `GET /v1/models` advertises models
    // an account cannot actually invoke - llama-3.1-nemotron-70b-instruct and
    // nemotron-4-340b-instruct both answered 404 "not found for account" - so
    // the catalogue is not evidence that a model works. Second, of the models
    // this account can run, this is the one measured returning schema-valid
    // JSON: nemotron-3-super-120b-a12b and nemotron-3.5-lightning both ignored
    // `response_format` and spent the whole token budget on prose.
    kind: 'openai_compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    label: 'nvidia',
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b',
    jsonMode: true,
  },
  gemini: {
    // Google's OpenAI compatibility layer. It is a real endpoint that speaks the
    // chat-completions shape, so it reuses the OpenAI adapter rather than
    // needing a second HTTP client.
    kind: 'openai_compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    label: 'gemini',
    defaultModel: 'gemini-2.5-flash',
    jsonMode: true,
  },
  anthropic: {
    // Native Messages API, not a compatibility layer - Anthropic does not have an
    // OpenAI-shaped endpoint, so the base URL is `/v1` and `AnthropicAnalyzer`
    // owns the request format. JSON comes back inside a forced tool call.
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    label: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    jsonMode: false,
  },
  local: {
    // No key, no network, no model. See the AI_PROVIDER comment and the
    // production guard in readEnv.
    kind: 'local',
    baseUrl: '',
    apiKeyEnv: null,
    label: 'local (heuristic)',
    defaultModel: 'local-heuristic-v1',
    jsonMode: false,
  },
};

export function presetFor(provider: AiProvider): ProviderPreset {
  return PRESETS[provider];
}

/** True when this provider needs a key, i.e. everything except `local`. */
export function requiresApiKey(provider: AiProvider): boolean {
  return PRESETS[provider].apiKeyEnv !== null;
}

/**
 * Where a `.env` is looked for, in order.
 *
 * `../../.env` first: this is a pnpm workspace, so every package script runs
 * with its working directory set to the package rather than the repository root,
 * where the file actually lives. Checking cwd alone therefore misses the file
 * and silently falls through to the ambient environment, which is how a missing
 * secret looks like a working setup until something needs it. Docker injects the
 * environment directly, so finding nothing at all is expected and fine.
 */
const ENV_FILE_CANDIDATES = ['../../.env', '.env'] as const;

/**
 * Loads the first readable env file, merges it under the real environment, then
 * validates. Never throws for a missing file.
 *
 * The file supplies defaults; the real environment wins. Node's `loadEnvFile`
 * overwrites anything already set, which is the opposite of what a container or a
 * CI job expects: `docker run -e API_PORT=8080` would be silently ignored in
 * favour of whatever the baked-in `.env` says, and the failure would look like
 * the service ignoring its configuration rather than like a precedence rule.
 *
 * `process.env` is mutated to achieve that, because `loadEnvFile` takes no
 * argument to read from anywhere else, and is then put back exactly as it was.
 * "Exactly" is the load-bearing word. Restoring only the variables that were
 * already present leaves behind the ones the file *added*, which then outrank
 * the next file read - so a second `readEnv` in the same process inherits the
 * first one's leftovers. The server calls this once and never noticed; the test
 * suite calls it dozens of times, where it silently decided what a later test
 * was testing.
 */
export function readEnv(envFile?: string): Env {
  const inherited = { ...process.env };

  try {
    for (const candidate of envFile === undefined ? ENV_FILE_CANDIDATES : [envFile]) {
      try {
        process.loadEnvFile(candidate);
        break;
      } catch {
        // Try the next location; an absent file is expected in Docker.
      }
    }

    // The file supplied the defaults; the real environment now overwrites them,
    // key by key. Keys only the file knows about are left alone, because they
    // are the defaults this call exists to apply.
    for (const [key, value] of Object.entries(inherited)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }

    normaliseEmptyVars();
    return parseEnv(process.env);
  } finally {
    // `process.env` is put back exactly as it was found. Restoring only the
    // variables that were already present would leave behind the ones the file
    // added, which then outrank the next file read - so a second `readEnv` in
    // the same process would inherit the first one's leftovers. The server calls
    // this once and never noticed; the test suite calls it dozens of times, where
    // it silently decided what a later test was testing.
    for (const key of Object.keys(process.env)) {
      if (!(key in inherited)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration -> ${detail}`);
  }

  const env = parsed.data;

  // The compose file ships a placeholder so `docker compose up` runs as a single
  // command. A committed default is a way in, so it is only ever allowed to be
  // the reason a local evaluation starts - never the reason a deployed one does.
  if (env.NODE_ENV === 'production' && env.ADMIN_API_SECRET === PLACEHOLDER_SECRET) {
    throw new Error(
      'ADMIN_API_SECRET is still the bundled placeholder, which is published in the ' +
        'repository. Set your own before starting in production: openssl rand -hex 32',
    );
  }

  const preset = PRESETS[env.AI_PROVIDER];
  if (env.NODE_ENV === 'production' && preset.kind === 'local') {
    throw new Error(
      'AI_PROVIDER=local runs a pattern matcher rather than a language model, so every ' +
        'request it reads is resolved by heuristics alone. Set a real provider before ' +
        'starting in production - a missing key is the safe way to run without one, ' +
        'because it escalates instead of guessing.',
    );
  }

  return env;
}

/**
 * Why the analyzer is unavailable, or null when it is configured.
 *
 * Reported rather than thrown. The caller builds an analyzer that reports the
 * same problem through the normal provider-failure path, so a missing key is
 * recorded in the audit trail of every request it touches - which is more useful
 * than a stack trace at boot that nobody reads after the deploy.
 */
export function missingApiKeyFor(env: Env): string | null {
  const preset = PRESETS[env.AI_PROVIDER];
  const apiKeyEnv = preset.apiKeyEnv;
  if (apiKeyEnv === null || env[apiKeyEnv] !== undefined) {
    return null;
  }
  return `${apiKeyEnv} is not set, so ${preset.label} cannot be reached`;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function fallbackModels(env: Env): string[] {
  return env.AI_FALLBACK_MODELS.split(',')
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
}
