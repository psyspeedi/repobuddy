/**
 * Return the current user's BYOK config (without the key itself — only
 * a "configured" flag so the UI can show "Active" without exposing the
 * cleartext).
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { users } from '../../db/schema'
import { requireValidUser } from '../../lib/auth'

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const [row] = await db
    .select({
      byokBaseUrl: users.byokBaseUrl,
      byokModel: users.byokModel,
      byokEmbeddingModel: users.byokEmbeddingModel,
      encryptedByokApiKey: users.encryptedByokApiKey,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)
  return {
    configured: Boolean(row?.encryptedByokApiKey),
    baseUrl: row?.byokBaseUrl ?? null,
    model: row?.byokModel ?? null,
    embeddingModel: row?.byokEmbeddingModel ?? null,
  }
})
