import { z } from 'zod';
import { INJECTION_ACTIONS } from '@refund/shared';

/**
 * Environment handling. Rule 7: check every return value, and never let a
 * missing key surface later as `undefined` deep inside a request. Everything
 * is validated once, at boot, so a misconfigured deployment fails immediately
 * and loudly instead of at the first customer request.
 */

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
   * The model to use. There is deliberately no "mock" or "none" option: the
   * product always talks to a real provider, and the test suite injects a fake
   * analyzer instead of switching the application into a different mode.
   */
  AI_PROVIDER: z.enum(['groq', 'openrouter', 'openai', 'nvidia']).default('groq'),
  /** Overrides the provider's default model when set. */
  AI_MODEL: z.string().min(1).optional(),
  AI_FALLBACK_MODELS: z.string().default(''),
  AI_BASE_URL: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
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

export interface ProviderPreset {
  readonly baseUrl: string;
  readonly apiKeyEnv: 'GROQ_API_KEY' | 'OPENROUTER_API_KEY' | 'OPENAI_API_KEY' | 'NVIDIA_API_KEY';
  readonly label: string;
  /** Used when AI_MODEL is unset, so the common case needs no model config. */
  readonly defaultModel: string;
}

const PRESETS: Record<AiProvider, ProviderPreset> = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    label: 'groq',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    label: 'openrouter',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    label: 'openai',
    defaultModel: 'gpt-4o-mini',
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
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    label: 'nvidia',
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b',
  },
};

export function presetFor(provider: AiProvider): ProviderPreset {
  return PRESETS[provider];
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
 * Loads the first readable env file, then validates. Never throws for a missing file.
 *
 * The file supplies defaults; the real environment wins. Node's `loadEnvFile`
 * overwrites anything already set, which is the opposite of what a container or a
 * CI job expects: `docker run -e API_PORT=8080` would be silently ignored in
 * favour of whatever the baked-in `.env` says, and the failure would look like
 * the service ignoring its configuration rather than like a precedence rule.
 * Existing variables are therefore snapshotted and restored after the load.
 */
export function readEnv(envFile?: string): Env {
  const inherited: Readonly<Record<string, string | undefined>> = { ...process.env };

  for (const candidate of envFile === undefined ? ENV_FILE_CANDIDATES : [envFile]) {
    try {
      process.loadEnvFile(candidate);
      break;
    } catch {
      // Try the next location; an absent file is expected in Docker.
    }
  }

  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration -> ${detail}`);
  }

  const env = parsed.data;
  const preset = PRESETS[env.AI_PROVIDER];
  if (!env[preset.apiKeyEnv]) {
    throw new Error(
      `AI_PROVIDER=${env.AI_PROVIDER} requires ${preset.apiKeyEnv}, which is not set. ` +
        'Add it to .env - see the README for how to get a free key.',
    );
  }

  return env;
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
