import type { Job } from 'bullmq'
import type { Database } from '../db/client'
import { getLogger, withTrace } from '../lib/logger'
import {
  markWorkspaceFailed,
  markWorkspaceReady,
  setWorkspaceProgress,
} from '../services/workspace-progress'
import type {
  IndexWorkspaceJobData,
  IndexWorkspaceJobResult,
} from '../queues'

const log = getLogger().child({ component: 'indexer/pipeline' })

/**
 * Phase 1.5 skeleton: walks workspace through status transitions without
 * doing real work. Real cloning/parsing/embeddings land in phase 2+.
 */
export async function runIndexPipeline(
  db: Database,
  job: Job<IndexWorkspaceJobData, IndexWorkspaceJobResult>,
): Promise<IndexWorkspaceJobResult> {
  const { workspaceId, userId } = job.data
  return withTrace({ workspaceId, userId, jobId: job.id }, async () => {
    const start = Date.now()
    log.info('pipeline started')

    try {
      await setWorkspaceProgress(db, workspaceId, {
        phase: 'cloning',
        percent: 10,
        message: 'Skeleton: would clone repository here',
      })
      await sleep(300)

      await setWorkspaceProgress(db, workspaceId, {
        phase: 'parsing',
        percent: 30,
        message: 'Skeleton: would parse AST here',
      })
      await sleep(300)

      await setWorkspaceProgress(db, workspaceId, {
        phase: 'extracting',
        percent: 60,
        message: 'Skeleton: would extract entities here',
      })
      await sleep(300)

      await setWorkspaceProgress(db, workspaceId, {
        phase: 'embedding',
        percent: 90,
        message: 'Skeleton: would embed chunks here',
      })
      await sleep(300)

      await markWorkspaceReady(db, workspaceId, {
        files: 0,
        entities: 0,
        relations: 0,
        chunks: 0,
        tokensSpent: 0,
      })
      const durationMs = Date.now() - start
      log.info({ durationMs }, 'pipeline ready')
      return { ok: true, filesProcessed: 0, durationMs }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err: msg }, 'pipeline failed')
      await markWorkspaceFailed(db, workspaceId, msg)
      throw err
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
