/**
 * Shared helpers for linking GitHub issue text back to indexed code.
 * Used by both the Tour-overlay REST endpoint and the list_issues
 * KAG operator so they produce identical relatedEntities + chunks.
 *
 * The pipeline is:
 *   1. extractRefs(title + body) → Set<string>   // backtick + path tokens
 *   2. lookupEntitiesByRefs(refs)  → Map<lookup, LinkedEntity[]>
 *   3. fetchChunksForEntities(ids) → ChunkRow[]  via entity_chunks join
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { chunks, entities, entityChunks, relations } from '../db/schema'

const REF_RE = /`([^`\n]{2,80})`/g
const PATH_RE = /(?<![\w/])([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|md))/g

export interface LinkedEntity {
  entityId: string
  name: string
  type: string
  filePath: string | null
  qualifiedName: string | null
  description: string | null
  inDegree: number
}

export interface LinkedChunk {
  id: string
  text: string
  filePath: string | null
  startLine: number | null
  endLine: number | null
}

export function extractRefs(text: string): Set<string> {
  const refs = new Set<string>()
  for (const m of text.matchAll(REF_RE)) {
    const v = m[1]?.trim()
    if (v && v.length >= 2 && v.length <= 80 && !/\s{2,}/.test(v)) refs.add(v)
  }
  for (const m of text.matchAll(PATH_RE)) {
    if (m[1]) refs.add(m[1])
  }
  return refs
}

/**
 * Resolve a set of natural-language refs (backtick tokens + file paths)
 * to actual graph entities. Returns a map keyed by the lowercased
 * lookup string. Refs without a match are simply absent from the map.
 */
export async function lookupEntitiesByRefs(
  db: Database,
  workspaceId: string,
  refs: string[],
): Promise<Map<string, LinkedEntity[]>> {
  const lower = [...new Set(refs.map((r) => r.toLowerCase()))].slice(0, 60)
  const namesOnly = lower.filter((r) => !r.includes('/'))
  const pathsOnly = lower.filter((r) => r.includes('/'))

  const out = new Map<string, LinkedEntity[]>()
  if (lower.length === 0) return out

  if (namesOnly.length > 0) {
    // Drizzle would serialise a JS array as a row constructor; build
    // ARRAY[$1, $2, ...]::text[] explicitly via sql.join.
    const arrayLiteral = sql`ARRAY[${sql.join(namesOnly.map((n) => sql`${n}`), sql`, `)}]::text[]`
    const rows = await db.execute<{
      id: string
      name: string
      type: string
      file_path: string | null
      qualified_name: string | null
      description: string | null
      lookup: string
      in_degree: number
    }>(sql`
      WITH targets AS (
        SELECT unnest(${arrayLiteral}) AS lookup
      )
      SELECT e.id, e.name, e.type, e.file_path, e.qualified_name, e.description,
             t.lookup,
             coalesce((
               SELECT count(*) FROM ${relations} r
               WHERE r.to_entity_id = e.id AND r.workspace_id = e.workspace_id
             ), 0)::int AS in_degree
      FROM targets t
      INNER JOIN ${entities} e
        ON e.workspace_id = ${workspaceId}
       AND (lower(e.name) = t.lookup OR lower(e.qualified_name) = t.lookup)
      LIMIT 200
    `)
    for (const r of rows) {
      const list = out.get(r.lookup) ?? []
      list.push({
        entityId: r.id,
        name: r.name,
        type: r.type,
        filePath: r.file_path,
        qualifiedName: r.qualified_name,
        description: r.description,
        inDegree: Number(r.in_degree),
      })
      out.set(r.lookup, list)
    }
  }

  for (const p of pathsOnly) {
    const rows = await db
      .select({
        id: entities.id,
        name: entities.name,
        type: entities.type,
        filePath: entities.filePath,
        qualifiedName: entities.qualifiedName,
        description: entities.description,
      })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          eq(entities.type, 'file'),
          isNotNull(entities.filePath),
          sql`lower(${entities.filePath}) LIKE ${'%' + p}`,
        ),
      )
      .limit(3)
    if (rows.length === 0) continue
    const list = out.get(p) ?? []
    for (const r of rows) {
      list.push({
        entityId: r.id,
        name: r.name,
        type: r.type,
        filePath: r.filePath,
        qualifiedName: r.qualifiedName,
        description: r.description,
        inDegree: 0,
      })
    }
    out.set(p, list)
  }

  return out
}

/**
 * Pull the chunks linked to a set of entities (via entity_chunks).
 * These are the snippets the answer operator will cite with
 * [chunk:UUID] markers, so the chat answer can ground in real code.
 */
export async function fetchChunksForEntities(
  db: Database,
  workspaceId: string,
  entityIds: string[],
  perEntityCap = 3,
): Promise<LinkedChunk[]> {
  const ids = [...new Set(entityIds)].slice(0, 30)
  if (ids.length === 0) return []
  const idsArray = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`
  // Window per entity so a single huge file doesn't crowd out the rest.
  const rows = await db.execute<{
    id: string
    text: string
    file_path: string | null
    start_line: number | null
    end_line: number | null
  }>(sql`
    SELECT id, text, file_path, start_line, end_line FROM (
      SELECT c.id, c.text, c.file_path, c.start_line, c.end_line,
             row_number() OVER (PARTITION BY ec.entity_id ORDER BY length(c.text)) AS rn
      FROM ${entityChunks} ec
      INNER JOIN ${chunks} c ON c.id = ec.chunk_id
      WHERE c.workspace_id = ${workspaceId}
        AND ec.entity_id = ANY(${idsArray})
    ) t
    WHERE rn <= ${perEntityCap}
    LIMIT 50
  `)
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
  }))
}

/**
 * Strip markdown noise from an issue body to surface 200-300 chars of
 * the description. Code blocks dropped (LLMs choke on truncated code
 * fences in the context section).
 */
export function excerptIssueBody(body: string): string {
  const cleaned = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/[#*_`>]/g, '')
    .trim()
  return cleaned.length > 280 ? cleaned.slice(0, 277) + '…' : cleaned
}
