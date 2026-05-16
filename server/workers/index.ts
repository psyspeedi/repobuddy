#!/usr/bin/env tsx
/**
 * Worker process entrypoint. Built as a standalone esbuild bundle
 * (`pnpm build:worker`) and run with `node .worker/index.mjs` in production,
 * or `pnpm dev:worker` in development (tsx watch).
 *
 * Listens to BullMQ queues; HTTP is intentionally absent.
 */
import 'dotenv/config'
import { Worker } from 'bullmq'
import { loadEnv } from '../lib/env'
import { getLogger, withTrace } from '../lib/logger'
import { closeDb, getDb } from '../db/client'
import { closeQueues, getRedisConnection, INDEX_WORKSPACE_QUEUE } from '../queues'
import type {
  IndexWorkspaceJobData,
  IndexWorkspaceJobResult,
} from '../queues'
import { runIndexPipeline } from '../indexer/pipeline'

const log = getLogger().child({ component: 'worker' })

async function main(): Promise<void> {
  const env = loadEnv()
  log.info({ role: env.PROCESS_ROLE }, 'worker starting')

  const db = getDb(env.DATABASE_URL)
  const connection = getRedisConnection(env.REDIS_URL)

  const worker = new Worker<IndexWorkspaceJobData, IndexWorkspaceJobResult>(
    INDEX_WORKSPACE_QUEUE,
    async (job) => runIndexPipeline(db, job),
    {
      connection,
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
    },
  )

  worker.on('completed', (job, result) => {
    void withTrace({ jobId: job.id }, () =>
      log.info({ result }, 'job completed'),
    )
  })

  worker.on('failed', (job, err) => {
    void withTrace({ jobId: job?.id }, () =>
      log.error({ err: err.message }, 'job failed'),
    )
  })

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down worker')
    await worker.close()
    await closeQueues()
    await closeDb()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  log.info('worker ready')
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, 'worker boot failed')
  process.exit(1)
})
