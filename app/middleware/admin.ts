/**
 * Page-level guard for /admin. Redirects non-admins to / and signs out
 * fully anonymous visitors via the global auth middleware.
 *
 * The server-side endpoints behind /admin do their own requireAdmin()
 * gate, so this middleware is just for UX (no UI flash before 403).
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path !== '/admin' && !to.path.startsWith('/admin/')) return
  const { loggedIn, user } = useUserSession()
  if (!loggedIn.value) {
    return navigateTo(`/login?next=${encodeURIComponent(to.fullPath)}`)
  }
  // Resolve admin status via the dedicated endpoint — keeps the canonical
  // ADMIN_LOGINS list on the server and out of the client bundle.
  try {
    await $fetch('/api/admin/overview')
  } catch {
    return navigateTo('/')
  }
  void user
})
