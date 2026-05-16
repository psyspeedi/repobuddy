import { and, eq } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { workspaces } from '../../../db/schema'

const POLL_MS = 1000
const HEARTBEAT_MS = 15000

/**
 * SSE endpoint streaming workspace progress until status becomes
 * 'ready' or 'failed'. Uses naive DB polling (1s) for MVP. A future
 * iteration could switch to Postgres LISTEN/NOTIFY or Redis pub/sub.
 */
export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // Verify ownership before opening stream
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, id), eq(workspaces.ownerUserId, user.id)))
    .limit(1)
  if (!ws) throw createError({ statusCode: 404, statusMessage: 'workspace not found' })

  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const eventStream = createEventStream(event)
  let lastSerialized = ''
  let alive = true

  const push = async (): Promise<boolean> => {
    const [current] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1)
    if (!current) return false
    const serialized = JSON.stringify({
      status: current.status,
      progress: current.progress,
      stats: current.stats,
      error: current.error,
    })
    if (serialized !== lastSerialized) {
      await eventStream.push({ event: 'progress', data: serialized })
      lastSerialized = serialized
    }
    return current.status !== 'ready' && current.status !== 'failed'
  }

  eventStream.onClosed(() => {
    alive = false
  })

  // Initial push
  const shouldContinue = await push()
  if (!shouldContinue) {
    await eventStream.push({ event: 'done', data: '{}' })
    await eventStream.close()
    return eventStream.send()
  }

  const heartbeat = setInterval(() => {
    if (!alive) return
    void eventStream.push({ event: 'heartbeat', data: String(Date.now()) })
  }, HEARTBEAT_MS)

  ;(async () => {
    try {
      while (alive) {
        await new Promise((r) => setTimeout(r, POLL_MS))
        if (!alive) break
        const cont = await push()
        if (!cont) {
          await eventStream.push({ event: 'done', data: '{}' })
          break
        }
      }
    } finally {
      clearInterval(heartbeat)
      await eventStream.close()
    }
  })().catch(() => {
    /* stream errored; closed below */
  })

  return eventStream.send()
})
