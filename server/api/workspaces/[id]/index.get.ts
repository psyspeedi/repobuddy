import { readAccess } from '../../../lib/workspace-access'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })
  const { workspace, viewerIsOwner } = await readAccess(event, id)
  return { workspace, viewerIsOwner }
})
