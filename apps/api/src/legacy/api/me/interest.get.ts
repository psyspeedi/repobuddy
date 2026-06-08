/**
 * Has the current user already expressed interest in `kind`?
 * Returns { sent: boolean, sentAt?: string } so the UI can disable
 * the button after the first click without an extra round-trip.
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../db/client'
import { interestPings } from '../../db/schema'
import { requireValidUser } from '../../lib/auth'

const QuerySchema = z.object({
  kind: z.string().min(1).max(64).default('more_limits'),
})

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const { kind } = QuerySchema.parse(getQuery(event))
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const [row] = await db
    .select()
    .from(interestPings)
    .where(and(eq(interestPings.userId, user.id), eq(interestPings.kind, kind)))
    .limit(1)
  return { sent: Boolean(row), sentAt: row?.createdAt ?? null }
})
