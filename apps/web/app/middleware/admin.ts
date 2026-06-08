/**
 * Page-level guard for /admin. Redirects non-admins to / and signs out
 * fully anonymous visitors via the global auth middleware. Server-side
 * endpoints behind /admin do their own AdminGuard, so this is purely
 * UX (no UI flash before 403).
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path !== '/admin' && !to.path.startsWith('/admin/')) return
  if (import.meta.server) return
  const { loggedIn } = useAuth()
  if (!loggedIn.value) {
    return navigateTo(`/login?next=${encodeURIComponent(to.fullPath)}`)
  }
  try {
    const me = await useApi()<{ isAdmin: boolean }>('/api/me/admin')
    if (!me.isAdmin) return navigateTo('/')
  } catch {
    return navigateTo('/')
  }
})
