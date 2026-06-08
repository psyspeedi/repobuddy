import { z } from 'zod'

/**
 * Treat empty strings the same as missing values. dotenv parses
 * `FOO=` as `FOO=""`, which Zod's `.url()` then rejects — surfaces as
 * "Invalid url" on optional vars that the user left blank in the
 * template. Wrapping with this preprocess lets us keep `.optional()`
 * semantics for blank lines.
 */
const optionalUrl = () =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional(),
  )

const optionalString = () =>
  z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().optional(),
  )

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().url().or(z.string().startsWith('postgres://')),
    REDIS_URL: z.string().url().or(z.string().startsWith('redis://')),

    // Legacy single-key path. Still works on its own — when set, used as
    // fallback for both LLM and embeddings if the unified vars below are
    // empty. At least one of OPENAI_API_KEY or LLM_API_KEY must be present.
    OPENAI_API_KEY: optionalString(),
    OPENAI_MODEL_EXTRACTION: z.string().default('gpt-4o-mini'),
    OPENAI_MODEL_PLANNING: z.string().default('gpt-4o'),
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

    // Unified OpenAI-compatible config. Point these at Groq, OpenRouter,
    // Together, Ollama, vLLM, anything that speaks the OpenAI chat
    // completions / embeddings API. When EMBEDDING_BASE_URL/_API_KEY are
    // unset, they fall through to LLM_BASE_URL/LLM_API_KEY, which in turn
    // fall through to OPENAI_API_KEY. Empty strings in .env are treated
    // as "not set" so leaving template defaults blank works fine.
    LLM_BASE_URL: optionalUrl(),
    LLM_API_KEY: optionalString(),
    LLM_MODEL_PLANNING: optionalString(),
    LLM_MODEL_EXTRACTION: optionalString(),

    EMBEDDING_BASE_URL: optionalUrl(),
    EMBEDDING_API_KEY: optionalString(),
    EMBEDDING_MODEL: optionalString(),

    GITHUB_CLIENT_ID: z.string().min(1, 'GITHUB_CLIENT_ID required'),
    GITHUB_CLIENT_SECRET: z.string().min(1, 'GITHUB_CLIENT_SECRET required'),
    NUXT_SESSION_PASSWORD: z
      .string()
      .min(32, 'NUXT_SESSION_PASSWORD must be at least 32 chars'),

    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32-byte hex (64 chars)'),

    APP_URL: z.string().url().default('http://localhost:3000'),
    APP_DOMAIN: z.string().default('localhost'),
    PROCESS_ROLE: z.enum(['web', 'worker']).default('web'),

    /** Comma-separated list of GitHub logins treated as admins (no quotas, can see all workspaces). */
    ADMIN_LOGINS: z.string().default(''),

    MAX_REPO_SIZE_MB: z.coerce.number().int().positive().default(200),
    MAX_FILES_PER_INDEX: z.coerce.number().int().positive().default(2000),
    LLM_BUDGET_USD_PER_INDEX: z.coerce.number().positive().default(2.0),

    /** Daily per-user quotas (admins bypass). */
    QUOTA_WORKSPACES_PER_DAY: z.coerce.number().int().nonnegative().default(3),
    QUOTA_MESSAGES_PER_DAY: z.coerce.number().int().nonnegative().default(50),
    QUOTA_TOKENS_PER_DAY: z.coerce.number().int().nonnegative().default(200_000),
    /** Guest quotas (cookie-pinned) — applied to anonymous visitors hitting a public workspace's chat. */
    QUOTA_GUEST_MESSAGES_PER_DAY: z.coerce.number().int().nonnegative().default(10),
    QUOTA_GUEST_TOKENS_PER_DAY: z.coerce.number().int().nonnegative().default(40_000),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    SENTRY_DSN: optionalUrl(),
    SENTRY_ENVIRONMENT: optionalString(),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

    TELEGRAM_BOT_TOKEN: optionalString(),
    TELEGRAM_CHAT_ID: optionalString(),

    COST_BUDGET_USD_PER_DAY: z.coerce.number().nonnegative().default(3),
  })
  .refine(
    (env) => Boolean(env.OPENAI_API_KEY || env.LLM_API_KEY),
    { message: 'At least one of OPENAI_API_KEY or LLM_API_KEY must be set' },
  )

export type Env = z.infer<typeof EnvSchema>

let _env: Env | null = null

/**
 * Validate process.env once, throw with detailed Zod issues on failure.
 * Safe to call multiple times — result is memoised.
 */
export function loadEnv(): Env {
  if (_env) return _env

  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment variables:\n${issues}`)
  }
  _env = parsed.data
  return _env
}

/** For tests only — clears the cached env so next loadEnv() re-parses. */
export function resetEnvCache(): void {
  _env = null
}
