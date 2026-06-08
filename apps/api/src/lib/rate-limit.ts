/**
 * Lightweight per-key sliding-window rate limiter on Redis.
 *
 * Approach: ZADD timestamp into a sorted set keyed by `key`, then
 * ZREMRANGEBYSCORE everything older than the window, then ZCARD to
 * read the current count. EXPIRE keeps stale keys from accumulating.
 *
 * Two operations + an EXPIRE per call — cheap enough for our scale.
 */
import { randomBytes } from 'node:crypto'
import { getQuotaRedis } from './quotas'

export interface RateLimitResult {
  ok: boolean
  limit: number
  remaining: number
  retryAfterSec: number
}

export async function rateLimitTake(
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const redis = getQuotaRedis()
  const now = Date.now()
  const windowStart = now - windowSec * 1000
  const member = `${now}-${randomBytes(4).toString('hex')}`

  // Pipeline the four ops. We rely on the response order to compute
  // the result; multi() guarantees atomicity within the connection.
  const pipe = redis.multi()
  pipe.zremrangebyscore(key, 0, windowStart)
  pipe.zadd(key, now, member)
  pipe.zcard(key)
  pipe.expire(key, windowSec * 2)
  const res = await pipe.exec()
  const count = Number((res?.[2]?.[1] as number | string | null) ?? 0)
  const remaining = Math.max(0, limit - count)
  const ok = count <= limit
  return {
    ok,
    limit,
    remaining,
    retryAfterSec: ok ? 0 : windowSec,
  }
}
