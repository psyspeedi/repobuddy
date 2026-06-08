/**
 * Hydrate auth state once at boot — replaces nuxt-auth-utils' implicit
 * fetch on every layout mount. SPA-style: the call runs only client-
 * side so SSR isn't blocked by the cross-origin API.
 */
export default defineNuxtPlugin(async () => {
  await useAuth().refresh()
})
