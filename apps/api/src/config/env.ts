import { createHash } from 'node:crypto';
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
  'AI_REQUIRED',
  'AI_API_KEY',
  'AI_PROVIDER',
  'AI_MODEL',
  'AI_BASE_URL',
  'AI_FALLBACK_MODELS',
  'ADMIN_API_SECRET',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
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

/**
 * Demo admin password, printed in `admin-login.txt` and shipped as the
 * documented default so a reviewer can sign in without inventing one. Rejected
 * in production for the same reason as the signing key: a password that is in
 * the repository is not a password. `adminEnabled` still requires it to be put
 * in the environment, so a clone with no `.env` has no admin console at all.
 */
export const PLACEHOLDER_ADMIN_PASSWORD = 'refund-desk-demo';

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
  * `local` is an explicit development-only pattern matcher. An absent provider
  * and absent key instead resolve to an unavailable analyzer, so the product
  * reports the missing model and escalates rather than making heuristic claims.
   */
  AI_PROVIDER: z.enum(['groq', 'openrouter', 'openai', 'nvidia', 'gemini', 'anthropic', 'local']).optional(),
  /**
   * Refuse to start without a working model, instead of degrading.
   *
   * The default degraded mode above is the right one for a demo and for an
   * operator mid-fix: the product stays up and queues work for a person. It is
   * the wrong one for a deployment that is supposed to *be* the model, because
   * there the failure is invisible from the outside - every request still
   * succeeds, escalates, and a person does the work the model was paid to do.
   * Nothing logs an error that anyone reads, and the bill for the model is being
   * paid for nothing.
   *
   * So this is the switch between the two, and it defaults to on in production:
   * a deployment that cannot reach its model should not be serving traffic, and
   * production already refuses `local` for the same reason. A string rather than
   * a boolean because the environment is text - `z.coerce.boolean()` reads the
   * non-empty string "false" as true, which is the wrong answer with no warning.
   *
   * Unset means: required in production, tolerated in development.
   */
  AI_REQUIRED: z.enum(['true', 'false']).optional(),
  /**
   * The key, whatever provider it belongs to.
   *
   * The one variable that has to be set to use a model. It exists because the
   * per-provider keys turned "paste your key and run" into a two-step ritual
   * with a lookup table: pick a provider, then find the matching variable name,
   * then discover that the key you hold is for the other one. Now the key goes
   * in here and the provider is worked out from it.
   *
   * Takes precedence over the per-provider variables, which stay supported so an
   * existing configuration keeps working untouched.
   */
  AI_API_KEY: z.string().min(1).optional(),
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
   * Withhold the order's item detail from the prompt. The order total is always
   * shared - it is the figure §4.1 reviews and the one the customer means by
   * "the whole order" - but item names and prices are hidden by default. S-18 is
   * the reason: the fewer order facts the model reads, the harder it is for a
   * fabricated quote to look like the customer's own words. Sharing the full
   * breakdown is an explicit opt-in.
   */
  AI_SHARE_ORDER_FACTS: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  // Uses the shared union so the env contract and R-14 cannot drift apart.
  INJECTION_ACTION: z.enum(INJECTION_ACTIONS).default('deny'),

  /**
   * The discretion layer: an automatic, rule-governed equivalent of the human
   * override, applied only to escalations and never to a denial. Off by default,
   * so a deployment that does not opt in decides exactly as it did before.
   *
   * The bounds below are the operator's pre-authorisation. They are read in one
   * place and threaded to the resolver like any other dependency, so the layer
   * can be tuned - or switched off - without a code change.
   */
  DISCRETION_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  /** The most a discretion rule may authorise in one decision. */
  DISCRETION_MAX_CENTS: z.coerce.number().int().positive().default(50_000),
  /** The higher cap a loyal (plus/enterprise) customer is authorised up to. */
  DISCRETION_LOYALTY_MAX_CENTS: z.coerce.number().int().positive().default(150_000),
  /** Courtesy window: how far past the 30-day standard window a grounded fault may still auto-approve. */
  DISCRETION_MAX_AGE_DAYS: z.coerce.number().int().positive().default(45),
  DISCRETION_ALLOW_PARTIAL: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  DISCRETION_ALLOW_EXCHANGE: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  DISCRETION_ALLOW_STORE_CREDIT: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  /** The lowest extraction confidence a discretion rule will accept for a low-risk claim. */
  DISCRETION_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
  /**
   * Near-miss quotes: accept an evidence quote that is *almost* verbatim (a
   * paraphrase the model smoothed over) for low-risk claims. Off by default,
   * because grounding is the guarantee that the model cannot fabricate a claim.
   */
  DISCRETION_NEAR_MISS_QUOTE: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((value) => value === 'true' || value === '1'),

  /**
   * The item picker: asking the customer which line a claim is about, from inside
   * the conversation, instead of requiring it before the conversation starts.
   *
   * On by default, unlike the discretion layer, because this can only ever
   * *narrow* what is claimed - the customer picks, or picks nothing and the claim
   * stays whole. It cannot widen a claim or move money on its own; the selection
   * arrives as an ordinary `itemIds` on the next request. The floor below is what
   * keeps it off small orders, where there is nothing worth choosing between.
   */
  AI_ITEM_PICKER_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((value) => value === 'true' || value === '1'),
  /**
   * The lowest whole-order eligible amount worth asking about.
   *
   * If every line on the order is worth a few dollars, the choice cannot change
   * what is paid and asking is a form field in disguise. Above this, an unresolved
   * scope is worth one question.
   */
  AI_ITEM_PICKER_MIN_CENTS: z.coerce.number().int().min(0).default(2500),
  /**
   * How many times one thread may be offered the picker.
   *
   * One, because the failure mode of an unanswered question is asking again: a
   * picker that returns on every turn is how a chat assistant teaches people to
   * abandon it. An order whose scope stays unresolved escalates, which is the
   * correct destination for an ambiguity nobody will resolve.
   */
  AI_ITEM_PICKER_MAX_OFFERS_PER_THREAD: z.coerce.number().int().min(0).max(5).default(1),

  /**
   * Consecutive failures before a model is taken out of the rotation.
   *
   * Three rather than one: a single 500 from a provider is noise, and tripping on it
   * would send a working model out of service for a cooldown. Counted
   * *consecutively*, so one success puts it straight back and a provider that is
   * merely flapping is never treated as down.
   */
  AI_BREAKER_FAILURES: z.coerce.number().int().min(1).max(10).default(3),
  /**
   * The lowest claim confidence the engine will act on without asking a person.
   *
   * A model that reports low confidence is telling us it is guessing, and a guess is
   * not a refund. The floor can only ever *escalate*: raising it sends more requests
   * to a person and never authorises more money, so the safe direction is the only
   * direction it has.
   *
   * Zero and one are both accepted, and one is the strict setting - every claim goes
   * to a person - which is a legitimate thing for an operator to want while a new
   * model is being introduced and nobody trusts its readings yet.
   */
  AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
  /**
   * Ask the provider not to spend tokens on reasoning.
   *
   * On by default, because it is the difference between a usable token budget and an
   * unusable one: a reasoning model spends `AI_MAX_TOKENS` thinking before emitting
   * any JSON, and on a long intake prompt that alone overruns the cap - which is
   * reported as a truncated reply, which this engine treats as no answer at all.
   * Turn it off for a model that reasons usefully, or for a provider that rejects the
   * argument (the adapter also retries once without it, so this is an optimisation
   * rather than a requirement).
   */
  /**
   * Seed synthetic shoppers, orders and live claims on boot.
   *
   * Default off in code and on in the compose stack. A production deployment seeds a
   * catalogue and nothing else, because an audit trail full of invented claims is the
   * one artefact this system exists not to produce; a reviewer's machine needs the
   * opposite, and it gets it without anyone editing a file first.
   */
  SEED_DEMO_DATA: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((value) => value === 'true' || value === '1'),

  AI_DISABLE_THINKING: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((value) => value === 'true' || value === '1'),
  /**
   * How long a tripped model is left alone before one probe is let through.
   *
   * Thirty seconds: long enough that a burst of traffic during an outage does not
   * re-probe on every request, short enough that a provider which comes back is
   * serving again almost immediately rather than at the next deploy.
   */
  AI_BREAKER_RESET_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

  /**
   * Caps the customer's message. A refund request is a paragraph, not an upload;
   * without a ceiling a single request can cost an unbounded number of prompt
   * tokens, and the request is stored verbatim before anything looks at it.
   */
  MAX_MESSAGE_LENGTH: z.coerce.number().int().positive().default(4000),

  /**
   * How far back a repeat of the same complaint counts as the same report.
   *
   * Bounded below at a minute, because a zero-width window would mean the check
   * never fires and the setting would look like it worked while doing nothing.
   * Bounded above, because a duplicate check that remembers forever eventually
   * stops recognising a new claim as new - a customer told "you already asked"
   * six months after a denial has been given no way to appeal.
   *
   * 72 hours is the default because that spans a weekend: the commonest repeat is
   * someone who sent it Friday, saw nothing, and sent it again Monday.
   */
  DUPLICATE_WINDOW_HOURS: z.coerce.number().int().min(0.02).max(24 * 90).default(72),
  /**
   * The admin console, and the only way into it.
   *
   * The console does not exist until both of these are set: `adminEnabled` is
   * false, every staff route answers 404, and `/api/health` says so. That is the
   * desired default - an unconfigured deployment has no admin surface to find,
   * let alone to attack - and it is why they are optional rather than required.
   * A clone that wants the console generates a password, puts the pair in
   * `.env`, and restarts. `admin-login.txt` carries the demo pair.
   *
   * Password is compared in constant time and exchanged for a short-lived signed
   * cookie, so the browser holds nothing reusable and a stolen cookie is valid
   * for hours rather than forever.
   */
  ADMIN_USERNAME: z.string().min(1).optional(),
  ADMIN_PASSWORD: z.string().min(12, 'ADMIN_PASSWORD must be at least 12 characters').optional(),
  /**
   * HMAC key for staff tokens and admin sessions.
   *
   * Optional and undefaulted. When set it is the signing key, so rotating it
   * invalidates every outstanding session at once. When only the login pair
   * above is set, the key is derived from the password instead - two variables
   * are enough to run the console. A server that cannot sign must not fall back
   * to trusting the caller, so there is no constant default here.
   */
  ADMIN_API_SECRET: z.string().min(32, 'ADMIN_API_SECRET must be at least 32 characters').optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WINDOW: z.string().min(1).default('1 minute'),
});

/**
 * The validated environment, with the provider always resolved.
 *
 * Intersected rather than inferred: the *input* schema leaves `AI_PROVIDER`
 * optional so an unset one can be inferred from the key, but nothing downstream
 * should ever have to handle it being absent. Every consumer gets a definite
 * provider and the inference happens once, in `readEnv`.
 */
export type Env = z.infer<typeof EnvSchema> & { AI_PROVIDER: AiProvider };

export type AiProvider = NonNullable<z.infer<typeof EnvSchema>['AI_PROVIDER']>;

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
  const parsed = EnvSchema.safeParse(withDevelopmentRateLimit(source));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration -> ${detail}`);
  }

  const env = resolveProvider(parsed.data);
  assertProductionCredentials(env);
  assertProductionProvider(env);
  assertModelIsReachable(env);
  return env;
}

/**
 * A Vite development session sends a burst of ordinary API reads through one
 * proxy/IP (and React StrictMode deliberately replays mount effects). Keep a real
 * limiter in development, but give that local workflow a larger default;
 * production and test retain the tighter 30/minute default. Explicit config
 * always wins.
 */
function withDevelopmentRateLimit(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return source.RATE_LIMIT_MAX === undefined && (source.NODE_ENV ?? 'development') === 'development'
    ? { ...source, RATE_LIMIT_MAX: '300' }
    : source;
}

/**
 * The compose file ships a placeholder and admin-login.txt ships a demo password,
 * so `docker compose up` runs as a single command. A committed default is a way
 * in, so it is only ever allowed to be the reason a local evaluation starts -
 * never the reason a deployed one does.
 */
function assertProductionCredentials(env: Env): void {
  if (env.NODE_ENV === 'production' && env.ADMIN_API_SECRET === PLACEHOLDER_SECRET) {
    throw new Error(
      'ADMIN_API_SECRET is still the bundled placeholder, which is published in the ' +
        'repository. Set your own before starting in production: openssl rand -hex 32',
    );
  }
  if (env.NODE_ENV === 'production' && env.ADMIN_PASSWORD === PLACEHOLDER_ADMIN_PASSWORD) {
    throw new Error(
      'ADMIN_PASSWORD is still the bundled demo password from admin-login.txt, which is ' +
        'published in the repository. Set your own before starting in production: ' +
        'openssl rand -base64 24',
    );
  }
}

function assertProductionProvider(env: Env): void {
  if (env.NODE_ENV !== 'production') {
    return;
  }
  if (PRESETS[env.AI_PROVIDER].kind === 'local') {
    throw new Error(
      'AI_PROVIDER=local runs a pattern matcher rather than a language model, so every ' +
        'request it reads is resolved by heuristics alone. Set a real provider before ' +
        'starting in production - a missing key is the safe way to run without one, ' +
        'because it escalates instead of guessing.',
    );
  }
}

/**
 * Works out which provider is meant, so setting one key is enough.
 *
 * Four cases, in order. An explicit `AI_PROVIDER` always wins, because someone
 * who wrote it meant it. Otherwise a key that identifies itself is trusted. A key
 * nobody recognises is an error, and that is a change worth defending: the
 * alternative is to guess, and the only guess available is "some vendor this
 * repository happens to know about" - which either calls an API the operator
 * never intended or, having no provider to call, quietly runs the product with no
 * model at all and reports nothing. A refusal naming the problem at boot is
 * better than either, and a key that identifies itself cannot cause it.
 *
 * With no key and no provider, choose a real provider preset without credentials.
 * `createAnalyzer` then produces an unavailable analyzer; it does not silently
 * turn a missing key into heuristic claim extraction.
 */
function resolveProvider(parsed: z.infer<typeof EnvSchema>): Env {
  if (parsed.AI_PROVIDER !== undefined) {
    return { ...parsed, AI_PROVIDER: parsed.AI_PROVIDER };
  }

  const inferred = providerFromKey(parsed.AI_API_KEY);
  if (inferred !== null) {
    return { ...parsed, AI_PROVIDER: inferred };
  }

  if (parsed.AI_API_KEY !== undefined) {
    throw new Error(
      'AI_API_KEY does not begin with a prefix this project recognises, so there is no way to ' +
        'tell which provider it belongs to. Set AI_PROVIDER to the provider it is for - that is ' +
        'also the answer for a self-hosted or OpenAI-compatible endpoint - or correct the key. ' +
        `Recognised prefixes: ${KNOWN_KEY_PREFIXES.join(', ')}.`,
    );
  }

  return { ...parsed, AI_PROVIDER: 'openai' };
}

/** The prefixes `providerFromKey` recognises, in one place for the error above. */
const KNOWN_KEY_PREFIXES: readonly string[] = ['gsk_', 'nvapi-', 'AIza', 'sk-or-v1-', 'sk-ant-', 'sk-'];

/**
 * Provider keys are self-identifying, and the prefixes do not collide.
 *
 * `sk-or-v1-` is checked before `sk-` because OpenRouter keys are also `sk-`, and
 * one provider's key sent to another is a confusing 401 rather than an obvious
 * misconfiguration. Anthropic is the same shape, so it is matched first there
 * too.
 *
 * Inference is a convenience with a hard floor under it: it can only ever
 * produce a provider the operator's key is genuinely for. Nothing here grants
 * access to anything, it just saves the operator reading a table.
 */
export function providerFromKey(key: string | undefined): AiProvider | null {
  if (key === undefined) {
    return null;
  }
  const value = key.trim();
  if (value.startsWith('gsk_')) {
    return 'groq';
  }
  if (value.startsWith('nvapi-')) {
    return 'nvidia';
  }
  if (value.startsWith('AIza')) {
    return 'gemini';
  }
  if (value.startsWith('sk-ant-')) {
    return 'anthropic';
  }
  if (value.startsWith('sk-or-v1-')) {
    return 'openrouter';
  }
  if (value.startsWith('sk-')) {
    return 'openai';
  }
  return null;
}

/**
 * The key to authenticate with, from either spelling.
 *
 * `AI_API_KEY` first so a key pasted there works without any further
 * configuration, then the provider's own variable so existing setups are
 * untouched. A provider with no key of its own - `local` - has none either way.
 */
export function apiKeyFor(env: Env): string | undefined {
  if (env.AI_API_KEY !== undefined) {
    return env.AI_API_KEY;
  }
  const apiKeyEnv = PRESETS[env.AI_PROVIDER].apiKeyEnv;
  return apiKeyEnv === null ? undefined : env[apiKeyEnv];
}

/** Whether this process must refuse to start without a usable model. */
export function isAiRequired(env: Env): boolean {
  return env.AI_REQUIRED === 'true' || (env.AI_REQUIRED === undefined && env.NODE_ENV === 'production');
}

/**
 * The boot guarantee: a process that is required to have a model does not start
 * without one.
 *
 * Only checked when required. The other mode - boot anyway, escalate everything -
 * is deliberate and defended above, and it is the right default for a demo and
 * for an operator mid-fix. This is the switch for when the process *is* the
 * model, where quietly degrading is the same as being down while looking healthy.
 */
function assertModelIsReachable(env: Env): void {
  if (!isAiRequired(env)) {
    return;
  }
  const preset = PRESETS[env.AI_PROVIDER];

  // `local` first. It is a working analyzer, so the missing-key check passes it,
  // and the error a reader would otherwise get is a confusing "no key variable
  // configured" for a provider that never wanted a key in the first place.
  if (preset.kind === 'local') {
    throw new Error(
      'AI_REQUIRED is on, but AI_PROVIDER=local is a pattern matcher rather than a ' +
        'language model. Set AI_PROVIDER to a real provider and its key, or unset ' +
        'AI_REQUIRED to run in the degraded mode that escalates instead of guessing.',
    );
  }

  const missing = missingApiKeyFor(env);
  if (missing === null) {
    return;
  }
  throw new Error(
    `${missing}. AI_REQUIRED is on, so the server will not start without a model - a ` +
      'deployment that cannot reach one cannot answer a customer, and starting anyway ' +
      'only turns a visible failure into an invisible one. Set the key in your .env (see ' +
      'the Configuration section of the README) and start again.',
  );
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
  if (preset.apiKeyEnv === null || apiKeyFor(env) !== undefined) {
    return null;
  }
  // Names the universal variable rather than the provider's own, because it is
  // the one an operator is told to set and it works for every provider.
  return `AI_API_KEY is not set, so ${preset.label} cannot be reached`;
}

/**
 * Whether the admin console exists.
 *
 * A single boolean, read by the route guards rather than by each route, so
 * "the console is not configured" is decided in exactly one place. Both halves
 * are required: a username with no password would otherwise be an admin that any
 * caller can walk past, and a password with no username has nobody to match.
 */
export function adminEnabled(env: Env): boolean {
  return env.ADMIN_USERNAME !== undefined && env.ADMIN_PASSWORD !== undefined;
}

/**
 * The credentials, or null when the console is not configured.
 *
 * Returns the pair rather than two optional reads at each call site, so a caller
 * cannot half-apply it: logging in with a username from one and a password from
 * the other is the failure this shape exists to make unrepresentable.
 */
export function adminCredentials(env: Env): { readonly username: string; readonly password: string } | null {
  if (!adminEnabled(env)) {
    return null;
  }
  // Both are checked above, so the narrowing is real rather than a cast.
  return { username: env.ADMIN_USERNAME ?? '', password: env.ADMIN_PASSWORD ?? '' };
}

/**
 * The key staff tokens and admin sessions are signed with.
 *
 * Prefers the dedicated `ADMIN_API_SECRET` when it is set, so rotating one
 * variable invalidates every outstanding session at once - the reason it is
 * worth having. Falls back to a value derived from the password when only the
 * login pair is configured, so the ordinary case is two variables rather than
 * three and the reviewer is not asked to generate a second secret.
 *
 * Derived, not raw: the password itself never becomes a key material argument
 * that a stray log line could print, and the domain-separated prefix keeps it
 * from colliding with anything else derived from the same input.
 *
 * Only meaningful when the console is configured; the guards check that first.
 */
export function adminSigningKey(env: Env): string {
  if (env.ADMIN_API_SECRET !== undefined) {
    return env.ADMIN_API_SECRET;
  }
  return createHash('sha256').update(`refund-desk.admin-session.${env.ADMIN_PASSWORD ?? ''}`).digest('hex');
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

/**
 * The circuit breaker's bounds.
 *
 * Out of the process env for the same reason as the two below: the ladder is then a
 * pure function of its inputs, and the breaker's state machine can be tested with a
 * clock it controls rather than with a sleep.
 */
export interface BreakerEnv {
  readonly failureThreshold: number;
  readonly resetAfterMs: number;
}

export function breakerConfig(env: Env): BreakerEnv {
  return { failureThreshold: env.AI_BREAKER_FAILURES, resetAfterMs: env.AI_BREAKER_RESET_MS };
}

/**
 * The item picker's bounds.
 *
 * Out of the process env for the same reason as `DiscretionConfig` below: the
 * retrieval stage that reads them stays a pure function, so the matrix deciding
 * when to ask can be tested with no process env at all.
 */
export interface ItemPickerConfig {
  /** Master switch. On by default; see the field's doc for why this differs. */
  readonly enabled: boolean;
  /** Below this whole-order eligible amount, never ask. */
  readonly minCents: number;
  /** How many offers one thread may receive. */
  readonly maxOffersPerThread: number;
}

export function itemPickerConfig(env: Env): ItemPickerConfig {
  return {
    enabled: env.AI_ITEM_PICKER_ENABLED,
    minCents: env.AI_ITEM_PICKER_MIN_CENTS,
    maxOffersPerThread: env.AI_ITEM_PICKER_MAX_OFFERS_PER_THREAD,
  };
}

/**
 * The discretion layer's pre-authorised bounds.
 *
 * The operator's pre-authorisation for the automatic, rule-governed equivalent of
 * the human override. Every field has a default so an unset deployment gets the
 * safe, off-by-default behaviour. See `policy/discretion.ts` for how these are
 * applied and `docs/adr/0003-discretion-layer.md` for why the layer exists.
 */
export interface DiscretionConfig {
  /** Master switch. Off by default: nothing changes until an operator opts in. */
  readonly enabled: boolean;
  /** The most a discretion rule may authorise in one decision. */
  readonly maxAmountCents: number;
  /** The higher cap a loyal (plus/enterprise) customer is authorised up to. */
  readonly loyaltyMaxAmountCents: number;
  /** Courtesy window: how far past the standard window a grounded fault may still auto-approve. */
  readonly maxAgeDays: number;
  readonly allowPartial: boolean;
  readonly allowExchange: boolean;
  readonly allowStoreCredit: boolean;
  /** The lowest extraction confidence a discretion rule will accept for a low-risk claim. */
  readonly minConfidence: number;
  /** Accept an almost-verbatim evidence quote for low-risk claims. Off by default. */
  readonly nearMissQuote: boolean;
}

/**
 * The discretion layer's pre-authorised bounds, read in one place.
 *
 * The resolver receives this rather than reading the environment itself, so the
 * layer stays a pure function of its inputs and the whole policy path can be
 * tested with no process env.
 */
export function discretionConfig(env: Env): DiscretionConfig {
  return {
    enabled: env.DISCRETION_ENABLED,
    maxAmountCents: env.DISCRETION_MAX_CENTS,
    loyaltyMaxAmountCents: env.DISCRETION_LOYALTY_MAX_CENTS,
    maxAgeDays: env.DISCRETION_MAX_AGE_DAYS,
    allowPartial: env.DISCRETION_ALLOW_PARTIAL,
    allowExchange: env.DISCRETION_ALLOW_EXCHANGE,
    allowStoreCredit: env.DISCRETION_ALLOW_STORE_CREDIT,
    minConfidence: env.DISCRETION_MIN_CONFIDENCE,
    nearMissQuote: env.DISCRETION_NEAR_MISS_QUOTE,
  };
}
