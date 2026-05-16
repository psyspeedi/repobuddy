import { and, eq } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { workspaces } from '../../../db/schema'
import { getIndexWorkspaceQueue } from '../../../queues'
import { requireValidUser } from '../../../lib/auth'
import { getLogger } from '../../../lib/logger'

const log = getLogger().child({ component: 'api/workspaces/reindex' })

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  const [ws] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, id), eq(workspaces.ownerUserId, user.id)))
    .limit(1)
  if (!ws) throw createError({ statusCode: 404, statusMessage: 'workspace not found' })
  if (ws.status === 'cloning' || ws.status === 'parsing' || ws.status === 'extracting' || ws.status === 'embedding') {
    throw createError({
      statusCode: 409,
      statusMessage: `workspace is already indexing (status: ${ws.status})`,
    })
  }

  // Reset workspace state so the UI immediately reflects the queued rerun.
  await db
    .update(workspaces)
    .set({
      status: 'pending',
      progress: {
        phase: 'pending',
        percent: 0,
        message: 'Queued for re-indexing',
        updatedAt: new Date().toISOString(),
      },
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, id))

  const queue = getIndexWorkspaceQueue(config.redisUrl as string)
  // BullMQ rejects an add() with the same jobId as an existing one (the
  // initial index job). Remove first to allow rerun.
  try {
    await queue.remove(id)
  } catch {
    /* ignore — job may not exist or already completed */
  }
  const job = await queue.add(
    'index',
    { workspaceId: id, userId: user.id },
    { jobId: id },
  )
  log.info({ workspaceId: id, jobId: job.id }, 'workspace re-indexing enqueued')

  return { ok: true, jobId: job.id }
})
