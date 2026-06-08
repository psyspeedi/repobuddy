/**
 * Cross-origin API helpers. After the NestJS migration apps/api lives
 * on a separate origin (:3001 in dev), so every request needs an
 * explicit baseURL + credentials so the session cookie is sent.
 *
 *   useApi()       — typed $fetch.create wrapper.
 *   useApiFetch()  — same defaults applied to Nuxt's useFetch.
 */
import type { UseFetchOptions } from 'nuxt/app'

const sharedDefaults = (apiBaseUrl: string) => ({
  baseURL: apiBaseUrl,
  credentials: 'include' as const,
})

export function useApi() {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  return $fetch.create(sharedDefaults(apiBaseUrl as string))
}

export function useApiFetch<T>(
  request: string | (() => string),
  opts: UseFetchOptions<T> = {},
) {
  const { public: { apiBaseUrl } } = useRuntimeConfig()
  return useFetch<T>(request, {
    baseURL: apiBaseUrl as string,
    credentials: 'include',
    ...opts,
  })
}
