/**
 * Page-level guard for /admin. Redirects non-admins to / and signs out
 * fully anonymous visitors via the global auth middleware.
 *
 * The server-side endpoints behind /admin do their own requireAdmin()
 * gate, so this middleware is just for UX (no UI flash before 403).
 *
 * Cookie handling: on the server side, plain `$fetch` does NOT forward
 * the incoming request's session cookie to a self-call. We need
 * `useRequestFetch()` which clones the H3 event's headers — otherwise
 * the admin probe always returns 401 during SSR and the redirect
 * fires even for legitimate admins.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path !== '/admin' && !to.path.startsWith('/admin/')) return
  const { loggedIn } = useUserSession()
  if (!loggedIn.value) {
    return navigateTo(`/login?next=${encodeURIComponent(to.fullPath)}`)
  }
  const fetcher = useRequestFetch()
  try {
    const me = await fetcher<{ isAdmin: boolean }>('/api/me/admin')
    if (!me.isAdmin) return navigateTo('/')
  } catch {
    return navigateTo('/')
  }
})
