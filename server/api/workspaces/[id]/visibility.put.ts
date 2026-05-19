/**
 * Owner-only toggle for workspaces.is_public. Admins can flip it too
 * (writeAccess accepts both).
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../../db/client'
import { users, workspaces } from '../../../db/schema'
import { writeAccess } from '../../../lib/workspace-access'
import { recordAudit, getClientIp } from '../../../lib/audit'

const BodySchema = z.object({ isPublic: z.boolean() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })
  const body = BodySchema.parse(await readBody(event))
  const access = await writeAccess(event, id)
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  await db
    .update(workspaces)
    .set({ isPublic: body.isPublic })
    .where(eq(workspaces.id, id))
  const [u] = await db
    .select({ githubLogin: users.githubLogin })
    .from(users)
    .where(eq(users.id, access.userId))
    .limit(1)
  await recordAudit(db, {
    userId: access.userId,
    actorLogin: u?.githubLogin ?? null,
    action: access.isAdmin ? 'admin.toggle_visibility' : 'workspace.visibility',
    targetType: 'workspace',
    targetId: id,
    metadata: { isPublic: body.isPublic },
    ip: getClientIp(event),
  })
  return { ok: true, isPublic: body.isPublic }
})
