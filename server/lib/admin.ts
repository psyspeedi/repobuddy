/**
 * Admin gate: ENV ADMIN_LOGINS is a comma-separated list of GitHub logins.
 * Admins bypass per-user quotas and can delete/edit any workspace.
 */
import { loadEnv } from './env'

let cached: Set<string> | null = null

export function isAdminLogin(login: string | null | undefined): boolean {
  if (!login) return false
  if (!cached) {
    const env = loadEnv()
    cached = new Set(
      env.ADMIN_LOGINS.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    )
  }
  return cached.has(login.toLowerCase())
}

/** Test hook — reset the memoised set so a new ENV is picked up. */
export function resetAdminCache(): void {
  cached = null
}
