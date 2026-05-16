import { z } from 'zod'

const EnvSchema = z.object({
  DATABASE_URL: z.string().url().or(z.string().startsWith('postgres://')),
  REDIS_URL: z.string().url().or(z.string().startsWith('redis://')),

  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY required'),
  OPENAI_MODEL_EXTRACTION: z.string().default('gpt-4o-mini'),
  OPENAI_MODEL_PLANNING: z.string().default('gpt-4o'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

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

  MAX_REPO_SIZE_MB: z.coerce.number().int().positive().default(200),
  MAX_FILES_PER_INDEX: z.coerce.number().int().positive().default(2000),
  LLM_BUDGET_USD_PER_INDEX: z.coerce.number().positive().default(2.0),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

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
