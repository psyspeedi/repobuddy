import { entities } from '#server/db/schema'
import type { GraphEntity } from './_types'

/** Pull ids out of a GraphEntity / array param, dropping anything without an id. */
export function idsFromParam(param: GraphEntity | GraphEntity[] | undefined): string[] {
  if (!param) return []
  const list = Array.isArray(param) ? param : [param]
  return list.map((e) => e?.id).filter((id): id is string => Boolean(id))
}

/** Standard projection used wherever we return a GraphEntity from a drizzle select. */
export function entityProjection() {
  return {
    id: entities.id,
    type: entities.type,
    name: entities.name,
    qualifiedName: entities.qualifiedName,
    filePath: entities.filePath,
    startLine: entities.startLine,
    endLine: entities.endLine,
    language: entities.language,
    description: entities.description,
  }
}
