/**
 * Onboarding bundle for the Tour overlay. Thin wrapper around the
 * shared project-overview helper so the same logic powers:
 *   - this endpoint (UI Tour)
 *   - the KAG `get_project_overview` operator (chat grounding)
 *
 * Response shape is preserved (entrypoints / coreAbstractions /
 * goodFirstIssues) — the helper returns extra fields (hotFiles,
 * stats) which the UI ignores for now.
 */
import { getDb } from '../../../db/client'
import { getProjectOverview } from '../../../lib/project-overview'
import { readAccess } from '../../../lib/workspace-access'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: 'id required' })
  await readAccess(event, workspaceId)

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  const overview = await getProjectOverview(db, workspaceId)
  return {
    entrypoints: overview.entrypoints,
    coreAbstractions: overview.coreAbstractions,
    goodFirstIssues: overview.goodFirstIssues,
  }
})
