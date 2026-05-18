/**
 * Owner-only toggle for workspaces.is_public. Admins can flip it too
 * (writeAccess accepts both).
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../../db/client'
import { workspaces } from '../../../db/schema'
import { writeAccess } from '../../../lib/workspace-access'

const BodySchema = z.object({ isPublic: z.boolean() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })
  const body = BodySchema.parse(await readBody(event))
  await writeAccess(event, id)
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  await db
    .update(workspaces)
    .set({ isPublic: body.isPublic })
    .where(eq(workspaces.id, id))
  return { ok: true, isPublic: body.isPublic }
})
