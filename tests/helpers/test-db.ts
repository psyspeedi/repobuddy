/**
 * Single source of truth for the test DB connection string. Every
 * integration test imports DATABASE_URL from here instead of reading
 * process.env directly, so tests can never silently target the dev
 * database and TRUNCATE-cascade a user's real workspaces.
 *
 * Resolution order:
 * 1. TEST_DATABASE_URL (explicit opt-in for CI / overrides)
 * 2. Default: localhost:5532/codegraph_test
 *
 * If DATABASE_URL is set to a non-_test database, refuse to run. This
 * catches `pnpm test` being invoked in a shell that also has a dev
 * DATABASE_URL exported.
 */
const DEFAULT_TEST_DB = 'postgres://codegraph:codegraph@localhost:5532/codegraph_test'

function resolveTestDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL
  if (explicit) {
    assertTestDatabase(explicit)
    return explicit
  }
  // If only DATABASE_URL is set, refuse it unless it points at a *_test DB.
  const fallback = process.env.DATABASE_URL
  if (fallback && fallback !== DEFAULT_TEST_DB) {
    assertTestDatabase(fallback)
    return fallback
  }
  return DEFAULT_TEST_DB
}

function assertTestDatabase(url: string): void {
  try {
    const parsed = new URL(url)
    const dbName = parsed.pathname.replace(/^\//, '')
    if (!dbName.endsWith('_test') && dbName !== 'codegraph_test') {
      throw new Error(
        `Refusing to run tests against "${dbName}" — database name must end in "_test". ` +
          `Set TEST_DATABASE_URL or use codegraph_test.`,
      )
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Refusing')) throw err
    throw new Error(`Invalid TEST/DATABASE_URL: ${url}`)
  }
}

export const TEST_DATABASE_URL = resolveTestDatabaseUrl()
