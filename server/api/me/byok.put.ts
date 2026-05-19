/**
 * Save (or clear) the current user's BYOK credentials. The API key is
 * encrypted before being persisted. baseUrl/model/embeddingModel are
 * stored in cleartext (no secret value).
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../db/client'
import { users } from '../../db/schema'
import { requireValidUser } from '../../lib/auth'
import { encrypt } from '../../lib/crypto'
import { loadEnv } from '../../lib/env'
import { recordAudit, getClientIp } from '../../lib/audit'

const BodySchema = z.object({
  baseUrl: z.string().url().nullable().optional(),
  model: z.string().min(1).max(128).nullable().optional(),
  embeddingModel: z.string().min(1).max(128).nullable().optional(),
  apiKey: z.string().min(1).max(512).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const body = await readBody(event)
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid BYOK payload',
      data: { issues: parsed.error.issues },
    })
  }

  const env = loadEnv()
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // `null` for apiKey means "remove BYOK"; `undefined` means "don't touch".
  const update: Record<string, string | null> = {}
  if (parsed.data.baseUrl !== undefined) update.byokBaseUrl = parsed.data.baseUrl
  if (parsed.data.model !== undefined) update.byokModel = parsed.data.model
  if (parsed.data.embeddingModel !== undefined) {
    update.byokEmbeddingModel = parsed.data.embeddingModel
  }
  if (parsed.data.apiKey !== undefined) {
    update.encryptedByokApiKey = parsed.data.apiKey
      ? encrypt(parsed.data.apiKey, env.ENCRYPTION_KEY)
      : null
  }

  if (Object.keys(update).length === 0) {
    return { ok: true, changed: false }
  }
  await db.update(users).set(update).where(eq(users.id, user.id))
  // Audit only the meaningful state transition; noisy partial updates
  // of model / baseUrl on their own aren't security-relevant.
  if (parsed.data.apiKey !== undefined) {
    await recordAudit(db, {
      userId: user.id,
      actorLogin: user.githubLogin,
      action: parsed.data.apiKey ? 'byok.set' : 'byok.clear',
      targetType: 'user',
      targetId: user.id,
      ip: getClientIp(event),
    })
  }
  return { ok: true, changed: true }
})
