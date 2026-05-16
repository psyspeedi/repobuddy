/**
 * Global auth middleware: redirect unauthenticated users to /login,
 * except for routes that explicitly opt out via `definePageMeta({ auth: false })`.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.meta.auth === false) return

  const { loggedIn } = useUserSession()
  if (!loggedIn.value) {
    return navigateTo(`/login${to.path === '/' ? '' : `?next=${encodeURIComponent(to.fullPath)}`}`)
  }
})
