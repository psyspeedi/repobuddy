/**
 * Recent audit events. Limit + optional action filter.
 */
import { and, desc, eq, lte } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { auditEvents } from '../../db/schema'
import { requireAdmin } from '../../lib/admin-guard'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const query = getQuery(event)
  const action = typeof query.action === 'string' ? query.action : null
  const limit = Math.min(Number(query.limit ?? 200), 500)
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const conditions = []
  if (action) conditions.push(eq(auditEvents.action, action))
  const rows = await db
    .select()
    .from(auditEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditEvents.at))
    .limit(limit)
  return { events: rows }
})
