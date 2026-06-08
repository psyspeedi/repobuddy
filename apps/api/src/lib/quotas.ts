/**
 * Per-user / per-guest daily quotas, stored in Redis with a 48-hour TTL.
 * Three counters per identity (user-uuid or guest-uuid) per day:
 *   - workspaces_created (users only; guests can't create)
 *   - messages_sent
 *   - tokens_used
 *
 * Admins (env ADMIN_LOGINS) and BYOK users bypass enforcement — they
 * carry their own bill so we don't gatekeep.
 *
 * `assert*` reads current usage and throws 429 if the action would exceed
 * the limit. `consume*` atomically increments after the action succeeds.
 * Splitting read from write lets us record the actual token usage that
 * comes back from the LLM (not a pre-flight estimate).
 */
import Redis from 'ioredis'
import { loadEnv } from './env'
import { quotaBlocks } from './metrics'

let _client: Redis | null = null
export function getQuotaRedis(): Redis {
  if (!_client) {
    const env = loadEnv()
    _client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 })
  }
  return _client
}

export interface QuotaContext {
  kind: 'user' | 'guest'
  id: string
  /** Admin / BYOK identities bypass enforcement entirely. */
  bypass?: boolean
}

export interface QuotaLimits {
  workspacesPerDay: number
  messagesPerDay: number
  tokensPerDay: number
}

export interface QuotaStatus {
  bypass: boolean
  limits: QuotaLimits
  used: {
    workspaces: number
    messages: number
    tokens: number
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

function keys(ctx: QuotaContext): {
  workspaces: string
  messages: string
  tokens: string
} {
  const day = todayUtc()
  const base = `cg:q:${ctx.kind}:${ctx.id}:${day}`
  return {
    workspaces: `${base}:workspaces`,
    messages: `${base}:messages`,
    tokens: `${base}:tokens`,
  }
}

const ONE_DAY_PLUS = 60 * 60 * 48 // 48h so the row covers tomorrow's first call cleanly

export function getLimits(ctx: QuotaContext): QuotaLimits {
  const env = loadEnv()
  if (ctx.kind === 'guest') {
    return {
      workspacesPerDay: 0,
      messagesPerDay: env.QUOTA_GUEST_MESSAGES_PER_DAY,
      tokensPerDay: env.QUOTA_GUEST_TOKENS_PER_DAY,
    }
  }
  return {
    workspacesPerDay: env.QUOTA_WORKSPACES_PER_DAY,
    messagesPerDay: env.QUOTA_MESSAGES_PER_DAY,
    tokensPerDay: env.QUOTA_TOKENS_PER_DAY,
  }
}

export async function getStatus(ctx: QuotaContext): Promise<QuotaStatus> {
  const limits = getLimits(ctx)
  if (ctx.bypass) {
    return {
      bypass: true,
      limits,
      used: { workspaces: 0, messages: 0, tokens: 0 },
    }
  }
  const redis = getQuotaRedis()
  const k = keys(ctx)
  const [w, m, t] = await redis.mget(k.workspaces, k.messages, k.tokens)
  return {
    bypass: false,
    limits,
    used: {
      workspaces: Number(w ?? 0),
      messages: Number(m ?? 0),
      tokens: Number(t ?? 0),
    },
  }
}

export async function assertCanCreateWorkspace(ctx: QuotaContext): Promise<void> {
  if (ctx.bypass) return
  if (ctx.kind === 'guest') {
    throw createError({ statusCode: 401, statusMessage: 'guests cannot create workspaces' })
  }
  const { limits, used } = await getStatus(ctx)
  if (used.workspaces >= limits.workspacesPerDay) {
    quotaBlocks.inc({ kind: ctx.kind, metric: 'workspaces' })
    throw createError({
      statusCode: 429,
      statusMessage: `Daily workspace quota exceeded (${used.workspaces}/${limits.workspacesPerDay}). Try again tomorrow.`,
    })
  }
}

export async function consumeWorkspace(ctx: QuotaContext): Promise<void> {
  if (ctx.bypass) return
  const redis = getQuotaRedis()
  const k = keys(ctx)
  await redis.multi().incr(k.workspaces).expire(k.workspaces, ONE_DAY_PLUS).exec()
}

export async function assertCanSendMessage(ctx: QuotaContext): Promise<void> {
  if (ctx.bypass) return
  const { limits, used } = await getStatus(ctx)
  if (used.messages >= limits.messagesPerDay) {
    quotaBlocks.inc({ kind: ctx.kind, metric: 'messages' })
    throw createError({
      statusCode: 429,
      statusMessage: `Daily message quota exceeded (${used.messages}/${limits.messagesPerDay}).`,
    })
  }
  if (used.tokens >= limits.tokensPerDay) {
    quotaBlocks.inc({ kind: ctx.kind, metric: 'tokens' })
    throw createError({
      statusCode: 429,
      statusMessage: `Daily token quota exceeded (${used.tokens}/${limits.tokensPerDay}).`,
    })
  }
}

export async function consumeMessage(ctx: QuotaContext): Promise<void> {
  if (ctx.bypass) return
  const redis = getQuotaRedis()
  const k = keys(ctx)
  await redis.multi().incr(k.messages).expire(k.messages, ONE_DAY_PLUS).exec()
}

export async function recordTokenUsage(
  ctx: QuotaContext,
  tokens: number,
): Promise<void> {
  if (ctx.bypass || tokens <= 0) return
  const redis = getQuotaRedis()
  const k = keys(ctx)
  await redis
    .multi()
    .incrby(k.tokens, Math.round(tokens))
    .expire(k.tokens, ONE_DAY_PLUS)
    .exec()
}
