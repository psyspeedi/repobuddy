/**
 * Replacement for nuxt-auth-utils' `useUserSession()`. Holds the
 * session payload returned by GET /api/auth/me in useState so every
 * component sees the same reactive snapshot. Refreshed once at boot
 * (plugins/auth.client.ts) and after any auth-side-effect.
 */
import { computed } from 'vue'

interface SessionUser {
  id: string
  githubId: string
  login: string
  email: string | null
  avatarUrl: string | null
}

export function useAuth() {
  const state = useState<{ user: SessionUser | null }>('auth-state', () => ({ user: null }))
  const api = useApi()

  const refresh = async () => {
    try {
      const data = await api<{ user: SessionUser | null }>('/api/auth/me')
      state.value = { user: data.user }
    } catch {
      state.value = { user: null }
    }
  }

  const clear = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch {
      /* even if the call fails, clear local state */
    }
    state.value = { user: null }
  }

  const loggedIn = computed(() => state.value.user !== null)
  const user = computed(() => state.value.user)
  return { user, loggedIn, refresh, clear }
}
