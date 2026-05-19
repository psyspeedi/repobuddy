import { Queue, type ConnectionOptions } from 'bullmq'

export const INDEX_WORKSPACE_QUEUE = 'index-workspace'
export const DIGEST_QUEUE = 'daily-digest'

export interface IndexWorkspaceJobData {
  workspaceId: string
  userId: string
}

export interface IndexWorkspaceJobResult {
  ok: boolean
  filesProcessed: number
  durationMs: number
}

export interface DigestJobData {
  /** ISO date the digest covers (yesterday in UTC). */
  day: string
}

let _connection: ConnectionOptions | null = null
let _queue: Queue<IndexWorkspaceJobData, IndexWorkspaceJobResult> | null = null
let _digestQueue: Queue<DigestJobData> | null = null

export function getRedisConnection(redisUrl: string): ConnectionOptions {
  if (!_connection) {
    // BullMQ accepts a URL string directly under .connection,
    // or you can pass an ioredis options object. Wrap as object for parse.
    const url = new URL(redisUrl)
    _connection = {
      host: url.hostname,
      port: Number(url.port || '6379'),
      password: url.password || undefined,
      // Required by BullMQ: do not retry forever on blocking commands.
      maxRetriesPerRequest: null,
    }
  }
  return _connection
}

export function getIndexWorkspaceQueue(
  redisUrl: string,
): Queue<IndexWorkspaceJobData, IndexWorkspaceJobResult> {
  if (!_queue) {
    _queue = new Queue<IndexWorkspaceJobData, IndexWorkspaceJobResult>(
      INDEX_WORKSPACE_QUEUE,
      {
        connection: getRedisConnection(redisUrl),
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: { count: 100, age: 24 * 3600 },
          removeOnFail: { count: 100, age: 7 * 24 * 3600 },
        },
      },
    )
  }
  return _queue
}

export function getDigestQueue(redisUrl: string): Queue<DigestJobData> {
  if (!_digestQueue) {
    _digestQueue = new Queue<DigestJobData>(DIGEST_QUEUE, {
      connection: getRedisConnection(redisUrl),
      defaultJobOptions: {
        attempts: 2,
        removeOnComplete: { count: 14 },
        removeOnFail: { count: 14 },
      },
    })
  }
  return _digestQueue
}

/**
 * Ensure a repeatable cron job fires the digest once a day. BullMQ
 * dedups by repeat key, so calling this on every worker boot is safe.
 * Runs at 09:00 UTC by default — early enough to land in mailbox
 * before standups, late enough that yesterday's UTC totals are final.
 */
export async function ensureDigestSchedule(redisUrl: string, cron = '0 9 * * *'): Promise<void> {
  const q = getDigestQueue(redisUrl)
  await q.add(
    'daily-digest',
    { day: new Date().toISOString().slice(0, 10) },
    { repeat: { pattern: cron, tz: 'UTC' } },
  )
}

export async function closeQueues(): Promise<void> {
  if (_queue) {
    await _queue.close()
    _queue = null
  }
  if (_digestQueue) {
    await _digestQueue.close()
    _digestQueue = null
  }
  _connection = null
}
