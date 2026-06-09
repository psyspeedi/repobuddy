/**
 * Cross-origin API helpers. After the NestJS migration apps/api lives
 * on a separate origin (:3001 in dev), so every request needs an
 * explicit baseURL + credentials so the session cookie is sent.
 *
 *   useApi()       — typed $fetch.create wrapper.
 *   useApiFetch()  — same defaults applied to Nuxt's useFetch.
 */

export function useApi() {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  return $fetch.create({
    baseURL: apiBaseUrl as string,
    credentials: 'include',
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useApiFetch<T>(request: any, opts: any = {}) {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  return useFetch<T>(request, {
    baseURL: apiBaseUrl as string,
    credentials: 'include',
    ...opts,
  })
}
