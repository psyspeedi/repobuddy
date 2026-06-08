/**
 * Bulk-delete workspaces by id. Used by /admin to clean up junk.
 * Cascades via FK like the single-id endpoint. Each delete is audited.
 */
import { inArray } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../db/client'
import { workspaces } from '../../db/schema'
import { requireAdmin } from '../../lib/admin-guard'
import { recordAudit, getClientIp } from '../../lib/audit'

const BodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
})

export default defineEventHandler(async (event) => {
  const admin = await requireAdmin(event)
  const body = BodySchema.parse(await readBody(event))
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const deleted = await db
    .delete(workspaces)
    .where(inArray(workspaces.id, body.ids))
    .returning({ id: workspaces.id, name: workspaces.name })
  for (const w of deleted) {
    await recordAudit(db, {
      userId: admin.id,
      actorLogin: admin.githubLogin,
      action: 'admin.delete_workspace',
      targetType: 'workspace',
      targetId: w.id,
      metadata: { name: w.name, bulk: true },
      ip: getClientIp(event),
    })
  }
  return { ok: true, deletedCount: deleted.length }
})
