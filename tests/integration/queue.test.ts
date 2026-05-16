import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { Queue, QueueEvents, Worker } from 'bullmq'
import { eq } from 'drizzle-orm'
import * as schema from '../../server/db/schema'
import { runIndexPipeline } from '../../server/indexer/pipeline'
import { getRedisConnection, INDEX_WORKSPACE_QUEUE } from '../../server/queues'
import type {
  IndexWorkspaceJobData,
  IndexWorkspaceJobResult,
} from '../../server/queues'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://codegraph:codegraph@localhost:5532/codegraph'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6479'

let sqlClient: postgres.Sql
let db: ReturnType<typeof drizzle<typeof schema>>
let queue: Queue<IndexWorkspaceJobData, IndexWorkspaceJobResult>
let worker: Worker<IndexWorkspaceJobData, IndexWorkspaceJobResult>
let events: QueueEvents
const connection = getRedisConnection(REDIS_URL)

beforeAll(async () => {
  sqlClient = postgres(DATABASE_URL, { max: 2 })
  db = drizzle(sqlClient, { schema })

  queue = new Queue<IndexWorkspaceJobData, IndexWorkspaceJobResult>(
    INDEX_WORKSPACE_QUEUE,
    { connection },
  )
  await queue.drain(true)
  await queue.clean(0, 1000, 'completed')
  await queue.clean(0, 1000, 'failed')

  worker = new Worker<IndexWorkspaceJobData, IndexWorkspaceJobResult>(
    INDEX_WORKSPACE_QUEUE,
    async (job) => runIndexPipeline(db, job),
    { connection, concurrency: 1 },
  )
  events = new QueueEvents(INDEX_WORKSPACE_QUEUE, { connection })
  await events.waitUntilReady()
}, 30000)

afterAll(async () => {
  await worker.close()
  await events.close()
  await queue.close()
  await sqlClient.end({ timeout: 2 })
}, 30000)

beforeEach(async () => {
  await sqlClient.unsafe(
    `TRUNCATE TABLE
      chat_messages, chat_sessions, query_cache, llm_cost_log,
      entity_chunks, relations, entities, chunks,
      oauth_tokens, workspaces, users
    RESTART IDENTITY CASCADE`,
  )
})

async function createUserAndWorkspace(): Promise<{
  userId: string
  workspaceId: string
}> {
  const [user] = await db
    .insert(schema.users)
    .values({ githubId: 'test-' + Math.random(), githubLogin: 'test' })
    .returning()
  const [ws] = await db
    .insert(schema.workspaces)
    .values({
      ownerUserId: user!.id,
      name: 'test repo',
      sourceType: 'github',
      sourceUrl: 'https://github.com/sindresorhus/p-limit',
    })
    .returning()
  return { userId: user!.id, workspaceId: ws!.id }
}

describe('indexer pipeline (skeleton)', () => {
  it('takes workspace from pending to ready via queue + worker', async () => {
    const { userId, workspaceId } = await createUserAndWorkspace()

    const job = await queue.add(
      'index',
      { workspaceId, userId },
      { jobId: workspaceId },
    )
    const result = (await job.waitUntilFinished(events, 15000)) as IndexWorkspaceJobResult
    expect(result.ok).toBe(true)

    const [ws] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1)

    expect(ws!.status).toBe('ready')
    expect(ws!.lastIndexedAt).not.toBeNull()
    const stats = ws!.stats as Record<string, number>
    expect(stats.files).toBe(0)
  })

  it('records progress phase transitions', async () => {
    const { userId, workspaceId } = await createUserAndWorkspace()

    const observedPhases: string[] = []
    const interval = setInterval(async () => {
      const [ws] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1)
      const phase = (ws?.progress as { phase?: string } | null)?.phase
      if (phase && !observedPhases.includes(phase)) observedPhases.push(phase)
    }, 50)

    const job = await queue.add(
      'index',
      { workspaceId, userId },
      { jobId: workspaceId },
    )
    await job.waitUntilFinished(events, 15000)
    clearInterval(interval)

    // Final sync read — the polling interval can race with waitUntilFinished
    // and miss the terminal phase.
    const [final] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1)
    const finalPhase = (final?.progress as { phase?: string } | null)?.phase
    if (finalPhase && !observedPhases.includes(finalPhase)) {
      observedPhases.push(finalPhase)
    }

    expect(observedPhases).toContain('ready')
    expect(observedPhases.length).toBeGreaterThanOrEqual(2)
  })
})
