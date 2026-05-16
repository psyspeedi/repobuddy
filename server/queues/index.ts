import { Queue, type ConnectionOptions } from 'bullmq'

export const INDEX_WORKSPACE_QUEUE = 'index-workspace'

export interface IndexWorkspaceJobData {
  workspaceId: string
  userId: string
}

export interface IndexWorkspaceJobResult {
  ok: boolean
  filesProcessed: number
  durationMs: number
}

let _connection: ConnectionOptions | null = null
let _queue: Queue<IndexWorkspaceJobData, IndexWorkspaceJobResult> | null = null

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

export async function closeQueues(): Promise<void> {
  if (_queue) {
    await _queue.close()
    _queue = null
  }
  _connection = null
}
