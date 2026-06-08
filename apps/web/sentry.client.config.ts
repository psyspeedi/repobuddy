/**
 * Sentry browser SDK init. The Nuxt module reads this file at boot.
 * No-op when SENTRY_DSN is unset (Sentry SDK accepts empty DSN and
 * silently disables itself).
 */
import * as Sentry from '@sentry/nuxt'

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN ?? '',
  environment: import.meta.env.MODE,
  tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
  // Drop noisy errors that aren't actionable.
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'NavigationDuplicated',
  ],
})
