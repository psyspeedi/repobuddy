import type { ConnectionOptions } from 'bullmq'

export const INDEX_WORKSPACE_QUEUE = 'index-workspace'

/**
 * Parse a redis:// URL into BullMQ-compatible ConnectionOptions.
 * Used by integration tests that bring up workers manually; production
 * goes through @nestjs/bullmq's `BullModule.forRootAsync`.
 */
export function getRedisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl)
  return {
    host: url.hostname,
    port: Number(url.port || '6379'),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  }
}

export interface IndexWorkspaceJobData {
  workspaceId: string
  userId: string | null
}

export interface IndexWorkspaceJobResult {
  ok: boolean
  filesProcessed?: number
  durationMs?: number
}
