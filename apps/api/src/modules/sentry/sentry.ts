import * as Sentry from '@sentry/nestjs'

/**
 * Initialize Sentry BEFORE NestFactory.create — required by
 * @sentry/nestjs to instrument the HTTP layer. No-op when SENTRY_DSN
 * is unset, so deploying without observability still works.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
  })
}
