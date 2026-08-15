/**
 * Cross-origin API helpers. After the NestJS migration apps/api lives
 * on a separate origin (:3001 in dev), so every request needs an
 * explicit baseURL + credentials so the session cookie is sent.
 *
 *   useApi()       — typed $fetch.create wrapper.
 *   useApiFetch()  — same defaults applied to Nuxt's useFetch.
 */

/**
 * Where to send this request.
 *
 * In a same-origin deployment apiBaseUrl is empty on purpose: the browser
 * issues relative /api/* calls and Caddy splits them between web and api.
 * That breaks during SSR — there is no Caddy in front of the Nuxt server,
 * so a relative URL resolves against the server itself (web:3000), which
 * serves no /api and answers 404. Every SSR payload came back empty while
 * the page still rendered, so it looked like the app worked.
 *
 * On the server we therefore call the API container directly when an
 * internal URL is configured. In dev apiInternalUrl is empty and
 * apiBaseUrl already points at :3001, so both paths behave the same.
 */
function apiBase(): string {
  const config = useRuntimeConfig()
  if (import.meta.server && config.apiInternalUrl) {
    return config.apiInternalUrl as string
  }
  return config.public.apiBaseUrl as string
}

export function useApi() {
  return $fetch.create({
    baseURL: apiBase(),
    credentials: 'include',
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useApiFetch<T>(request: any, opts: any = {}) {
  // On SSR the request is made by the Nuxt server, not the browser,
  // so the browser's session cookie isn't sent automatically. Forward
  // the incoming Cookie header so the API sees the same session.
  // useRequestHeaders is a no-op on the client.
  const headers = useRequestHeaders(['cookie'])
  return useFetch<T>(request, {
    baseURL: apiBase(),
    credentials: 'include',
    ...opts,
    headers: { ...headers, ...(opts.headers ?? {}) },
  })
}
