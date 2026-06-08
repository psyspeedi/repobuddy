/**
 * Hard delete a workspace. ON DELETE CASCADE on every FK referencing
 * workspaces.id wipes entities / relations / chunks / chat sessions /
 * messages / query_cache / llm_cost_log in one shot. No tombstone.
 *
 * Requires ownership — admins can delete via the same endpoint because
 * the admin check sits on top of ownership in the workspaces filter.
 */
import { and, eq } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { workspaces } from '../../../db/schema'
import { requireValidUser } from '../../../lib/auth'
import { getLogger } from '../../../lib/logger'
import { isAdminLogin } from '../../../lib/admin'
import { recordAudit, getClientIp } from '../../../lib/audit'

const log = getLogger().child({ component: 'api/workspaces/delete' })

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  const whereClause = isAdminLogin(user.githubLogin)
    ? eq(workspaces.id, id)
    : and(eq(workspaces.id, id), eq(workspaces.ownerUserId, user.id))

  const deleted = await db
    .delete(workspaces)
    .where(whereClause)
    .returning({ id: workspaces.id })
  if (deleted.length === 0) {
    throw createError({ statusCode: 404, statusMessage: 'workspace not found' })
  }
  await recordAudit(db, {
    userId: user.id,
    actorLogin: user.githubLogin,
    action: isAdminLogin(user.githubLogin) ? 'admin.delete_workspace' : 'workspace.delete',
    targetType: 'workspace',
    targetId: id,
    ip: getClientIp(event),
  })
  log.info({ workspaceId: id, userId: user.id }, 'workspace deleted')
  return { ok: true }
})
