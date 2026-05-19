/**
 * Record one interest ping per (user, kind). Re-posting the same
 * kind is a no-op (returns the existing row) thanks to the UNIQUE
 * constraint — no errors thrown.
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../db/client'
import { interestPings } from '../../db/schema'
import { requireValidUser } from '../../lib/auth'
import { getLogger } from '../../lib/logger'

const log = getLogger().child({ component: 'api/me/interest' })

const BodySchema = z.object({
  kind: z.string().min(1).max(64).default('more_limits'),
  message: z.string().trim().max(500).optional(),
})

export default defineEventHandler(async (event) => {
  const user = await requireValidUser(event)
  const body = BodySchema.parse(await readBody(event))
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const existing = await db
    .select()
    .from(interestPings)
    .where(and(eq(interestPings.userId, user.id), eq(interestPings.kind, body.kind)))
    .limit(1)
  if (existing[0]) return { ok: true, alreadySent: true }
  await db
    .insert(interestPings)
    .values({ userId: user.id, kind: body.kind, message: body.message || null })
    .onConflictDoNothing()
  log.info({ userId: user.id, kind: body.kind, hasMessage: !!body.message }, 'interest recorded')
  return { ok: true, alreadySent: false }
})
