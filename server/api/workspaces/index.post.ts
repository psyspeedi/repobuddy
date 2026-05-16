import { getDb } from '../../db/client'
import { workspaces } from '../../db/schema'
import { getIndexWorkspaceQueue } from '../../queues'
import { CreateWorkspaceSchema } from '#shared/schemas/workspace'
import { getLogger } from '../../lib/logger'

const log = getLogger().child({ component: 'api/workspaces/create' })

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const config = useRuntimeConfig(event)
  const body = await readBody(event)
  const parsed = CreateWorkspaceSchema.safeParse(body)
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid workspace payload',
      data: { issues: parsed.error.issues },
    })
  }
  const { source, name } = parsed.data
  const computedName =
    name ??
    (source.type === 'github'
      ? deriveNameFromUrl(source.url)
      : source.filename.replace(/\.zip$/i, ''))

  const db = getDb(config.databaseUrl as string)
  const [created] = await db
    .insert(workspaces)
    .values({
      ownerUserId: user.id,
      name: computedName,
      sourceType: source.type,
      sourceUrl: source.type === 'github' ? source.url : null,
      status: 'pending',
      progress: {
        phase: 'pending',
        percent: 0,
        message: 'Queued for indexing',
        updatedAt: new Date().toISOString(),
      },
    })
    .returning()

  if (!created) {
    throw createError({ statusCode: 500, statusMessage: 'workspace insert failed' })
  }

  const queue = getIndexWorkspaceQueue(config.redisUrl as string)
  const job = await queue.add(
    'index',
    { workspaceId: created.id, userId: user.id },
    { jobId: created.id },
  )
  log.info({ workspaceId: created.id, jobId: job.id }, 'workspace enqueued')

  return { workspace: created, jobId: job.id }
})

function deriveNameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length >= 2) return `${parts[0]}/${parts[1]?.replace(/\.git$/, '')}`
    return u.pathname || 'workspace'
  } catch {
    return 'workspace'
  }
}
