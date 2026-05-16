import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { pino, type Logger } from 'pino'

interface TraceContext {
  traceId: string
  workspaceId?: string
  userId?: string
  jobId?: string
}

const traceStorage = new AsyncLocalStorage<TraceContext>()

const isDev = process.env.NODE_ENV !== 'production'

const baseLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'codegraph', role: process.env.PROCESS_ROLE ?? 'web' },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const ctx = traceStorage.getStore()
    return ctx ? { ...ctx } : {}
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,service',
          },
        },
      }
    : {}),
})

export function getLogger(): Logger {
  return baseLogger
}

/**
 * Run `fn` inside a logging context. Every log line produced underneath will
 * include the traceId and any other context fields automatically. Nested calls
 * inherit and may override fields.
 */
export function withTrace<T>(
  context: Partial<TraceContext>,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  const parent = traceStorage.getStore()
  const merged: TraceContext = {
    traceId: context.traceId ?? parent?.traceId ?? randomUUID(),
    workspaceId: context.workspaceId ?? parent?.workspaceId,
    userId: context.userId ?? parent?.userId,
    jobId: context.jobId ?? parent?.jobId,
  }
  return traceStorage.run(merged, fn)
}

export function currentTrace(): TraceContext | undefined {
  return traceStorage.getStore()
}
