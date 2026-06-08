import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadEnv, resetEnvCache } from '#server/lib/env'

const ORIGINAL_ENV = { ...process.env }

function setBaseEnv(): void {
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/d'
  process.env.REDIS_URL = 'redis://localhost:6379'
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.GITHUB_CLIENT_ID = 'ghid'
  process.env.GITHUB_CLIENT_SECRET = 'ghsecret'
  process.env.NUXT_SESSION_PASSWORD = 'x'.repeat(32)
  process.env.ENCRYPTION_KEY = '0'.repeat(64)
}

beforeEach(() => {
  resetEnvCache()
  for (const key of Object.keys(process.env)) delete process.env[key]
  setBaseEnv()
})

afterEach(() => {
  resetEnvCache()
  for (const key of Object.keys(process.env)) delete process.env[key]
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v !== undefined) process.env[k] = v
  }
})

describe('loadEnv', () => {
  it('parses valid env', () => {
    const env = loadEnv()
    expect(env.DATABASE_URL).toBe('postgres://u:p@localhost:5432/d')
    expect(env.OPENAI_MODEL_PLANNING).toBe('gpt-4o')
    expect(env.PROCESS_ROLE).toBe('web')
    expect(env.MAX_REPO_SIZE_MB).toBe(200)
  })

  it('coerces numeric env vars', () => {
    process.env.MAX_REPO_SIZE_MB = '500'
    process.env.LLM_BUDGET_USD_PER_INDEX = '0.5'
    const env = loadEnv()
    expect(env.MAX_REPO_SIZE_MB).toBe(500)
    expect(env.LLM_BUDGET_USD_PER_INDEX).toBe(0.5)
  })

  it('rejects missing OPENAI_API_KEY', () => {
    delete process.env.OPENAI_API_KEY
    expect(() => loadEnv()).toThrow(/OPENAI_API_KEY/)
  })

  it('rejects short NUXT_SESSION_PASSWORD', () => {
    process.env.NUXT_SESSION_PASSWORD = 'short'
    expect(() => loadEnv()).toThrow(/NUXT_SESSION_PASSWORD/)
  })

  it('rejects malformed ENCRYPTION_KEY', () => {
    process.env.ENCRYPTION_KEY = 'not-hex'
    expect(() => loadEnv()).toThrow(/ENCRYPTION_KEY/)
  })

  it('rejects invalid PROCESS_ROLE', () => {
    process.env.PROCESS_ROLE = 'master'
    expect(() => loadEnv()).toThrow(/PROCESS_ROLE/)
  })

  it('memoises result across calls', () => {
    const a = loadEnv()
    const b = loadEnv()
    expect(a).toBe(b)
  })
})
