import { eq, sql, inArray } from 'drizzle-orm'
import type { Database } from '../db/client'
import { chunks, entities, entityChunks, relations } from '../db/schema'
import type { ParsedEntity, ParsedRelation } from './parsers/types'
import type { CodeChunk } from './chunking/chunker'
import type { GitHistory, GitCommit, GitAuthor } from './git/history'
import { getLogger } from '../lib/logger'

const log = getLogger().child({ component: 'indexer/persist' })

export interface PersistResult {
  entityCount: number
  relationCount: number
  chunkCount: number
  commitCount: number
}

/**
 * Wipe everything we own under a workspace. Used at the start of every
 * indexing run so reruns are idempotent.
 */
export async function clearWorkspaceGraph(
  db: Database,
  workspaceId: string,
): Promise<void> {
  // FK ON DELETE CASCADE handles relations + entity_chunks once we drop
  // entities/chunks. We rely on table-level cascade rather than manual deletes.
  await db.delete(relations).where(eq(relations.workspaceId, workspaceId))
  await db.delete(entityChunks).where(
    sql`${entityChunks.chunkId} IN (SELECT id FROM ${chunks} WHERE workspace_id = ${workspaceId})`,
  )
  await db.delete(chunks).where(eq(chunks.workspaceId, workspaceId))
  await db.delete(entities).where(eq(entities.workspaceId, workspaceId))
}

/**
 * Bulk-insert parsed entities for a workspace and return a
 * qualifiedName → id map so subsequent relation/chunk inserts can
 * resolve foreign keys without an extra round-trip.
 */
export async function insertEntities(
  db: Database,
  workspaceId: string,
  parsed: ParsedEntity[],
): Promise<Map<string, string>> {
  if (parsed.length === 0) return new Map()

  // Dedupe by (workspaceId, qualifiedName) before batching. Postgres rejects
  // an INSERT … ON CONFLICT DO UPDATE that affects the same conflict-target
  // row twice in one statement (declaration merging, namespace re-opens,
  // duplicate file walks all cause this). Last write wins.
  const byKey = new Map<string, ParsedEntity>()
  const nullKeyed: ParsedEntity[] = []
  for (const e of parsed) {
    if (e.qualifiedName) {
      byKey.set(e.qualifiedName, e)
    } else {
      // Entities without qualified_name (rare — usually module/concept) can
      // coexist; the unique constraint treats each NULL as distinct.
      nullKeyed.push(e)
    }
  }
  const deduped: ParsedEntity[] = [...byKey.values(), ...nullKeyed]

  const rows = deduped.map((e) => ({
    workspaceId,
    type: e.type,
    name: e.name,
    qualifiedName: e.qualifiedName,
    normalizedName: e.name.toLowerCase(),
    language: e.language,
    filePath: e.filePath,
    startLine: e.startLine,
    endLine: e.endLine,
    signature: e.signature,
    visibility: e.visibility,
    metadata: e.metadata ?? {},
  }))

  // Insert in batches to avoid hitting param limits.
  const idMap = new Map<string, string>()
  const BATCH = 500
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const inserted = await db
      .insert(entities)
      .values(batch)
      .onConflictDoUpdate({
        target: [entities.workspaceId, entities.qualifiedName],
        set: {
          name: sql`excluded.name`,
          type: sql`excluded.type`,
          normalizedName: sql`excluded.normalized_name`,
          language: sql`excluded.language`,
          filePath: sql`excluded.file_path`,
          startLine: sql`excluded.start_line`,
          endLine: sql`excluded.end_line`,
          signature: sql`excluded.signature`,
          visibility: sql`excluded.visibility`,
          metadata: sql`excluded.metadata`,
        },
      })
      .returning({ id: entities.id, qualifiedName: entities.qualifiedName })
    for (const row of inserted) {
      if (row.qualifiedName) idMap.set(row.qualifiedName, row.id)
    }
  }
  if (parsed.length !== deduped.length) {
    log.info(
      { workspaceId, raw: parsed.length, deduped: deduped.length },
      'deduplicated parsed entities before insert',
    )
  }
  return idMap
}

/**
 * Insert relations, resolving fromQualified/toQualified against the
 * workspace-local entity id map. Relations whose target cannot be resolved
 * (external symbol, unknown call target, etc.) are dropped — they have no
 * place in the graph yet, but their evidence is preserved on calls via
 * chunk text.
 */
const COMMON_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '.vue', '.py', '.go']
const INDEX_FILES = COMMON_EXTENSIONS.map((ext) => `/index${ext}`)

export async function insertRelations(
  db: Database,
  workspaceId: string,
  parsed: ParsedRelation[],
  idMap: Map<string, string>,
  /** Secondary index keyed by short name so cross-file calls can resolve. */
  nameIndex: Map<string, string[]>,
): Promise<number> {
  const rows: typeof relations.$inferInsert[] = []
  for (const r of parsed) {
    const fromId = idMap.get(r.fromQualified)
    if (!fromId) continue
    const toId = resolveTarget(r, idMap, nameIndex)
    if (!toId) continue
    rows.push({
      workspaceId,
      fromEntityId: fromId,
      toEntityId: toId,
      type: r.type,
      evidenceQuote: r.evidenceQuote,
      metadata: r.metadata ?? {},
    })
  }
  if (rows.length === 0) return 0
  const BATCH = 500
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insert(relations).values(rows.slice(i, i + BATCH))
  }
  log.info({ count: rows.length }, 'inserted relations')
  return rows.length
}

function resolveTarget(
  r: ParsedRelation,
  idMap: Map<string, string>,
  nameIndex: Map<string, string[]>,
): string | null {
  // Exact qualified name match first.
  const direct = idMap.get(r.toQualified)
  if (direct) return direct

  // For import-like targets (path-shaped, no `::`), try common extensions
  // and /index.* variations.
  if (!r.toQualified.includes('::')) {
    for (const ext of COMMON_EXTENSIONS) {
      const id = idMap.get(`${r.toQualified}${ext}`)
      if (id) return id
    }
    for (const idx of INDEX_FILES) {
      const id = idMap.get(`${r.toQualified}${idx}`)
      if (id) return id
    }
  }

  // Fall back to short-name lookup if the parser provided one.
  if (r.toName) {
    const candidates = nameIndex.get(r.toName.toLowerCase())
    if (candidates && candidates.length > 0) return candidates[0] ?? null
  }
  return null
}

/** Insert code/doc chunks for the workspace. */
export async function insertChunks(
  db: Database,
  workspaceId: string,
  codeChunks: CodeChunk[],
): Promise<{ ids: string[]; chunkByQualified: Map<string, string[]> }> {
  if (codeChunks.length === 0) {
    return { ids: [], chunkByQualified: new Map() }
  }
  const rows = codeChunks.map((c) => ({
    workspaceId,
    sourceType: c.sourceType,
    filePath: c.filePath,
    startLine: c.startLine,
    endLine: c.endLine,
    text: c.text,
    metadata: c.metadata ?? {},
  }))

  const ids: string[] = []
  const chunkByQualified = new Map<string, string[]>()
  const BATCH = 200
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const inserted = await db.insert(chunks).values(batch).returning({
      id: chunks.id,
      filePath: chunks.filePath,
    })
    for (let j = 0; j < inserted.length; j++) {
      const insertedRow = inserted[j]
      const sourceRow = batch[j]
      if (!insertedRow || !sourceRow) continue
      ids.push(insertedRow.id)
      const q = (sourceRow.metadata as { qualifiedName?: string })?.qualifiedName
      if (q) {
        const arr = chunkByQualified.get(q) ?? []
        arr.push(insertedRow.id)
        chunkByQualified.set(q, arr)
      }
    }
  }
  return { ids, chunkByQualified }
}

/**
 * Populate the mutual index: each entity gets linked to chunks whose
 * metadata.qualifiedName matches its qualified name.
 */
export async function linkEntityChunks(
  db: Database,
  idMap: Map<string, string>,
  chunkByQualified: Map<string, string[]>,
): Promise<void> {
  const pairs: typeof entityChunks.$inferInsert[] = []
  for (const [qualified, chunkIds] of chunkByQualified) {
    const entityId = idMap.get(qualified)
    if (!entityId) continue
    for (const chunkId of chunkIds) {
      pairs.push({ entityId, chunkId })
    }
  }
  if (pairs.length === 0) return
  const BATCH = 1000
  for (let i = 0; i < pairs.length; i += BATCH) {
    await db
      .insert(entityChunks)
      .values(pairs.slice(i, i + BATCH))
      .onConflictDoNothing()
  }
}

/** Persist git commits, persons, and authored/modified_by relations. */
export async function persistGitHistory(
  db: Database,
  workspaceId: string,
  history: GitHistory,
  fileIdByPath: Map<string, string>,
): Promise<number> {
  if (history.commits.length === 0) return 0

  const personByKey = new Map<string, GitAuthor>()
  for (const a of history.authors) {
    personByKey.set(`${a.name}::${a.email}`.toLowerCase(), a)
  }

  // Insert persons.
  const personIdByKey = new Map<string, string>()
  if (history.authors.length > 0) {
    const personRows = history.authors.map((a) => ({
      workspaceId,
      type: 'person' as const,
      name: a.name,
      qualifiedName: `person::${a.email || a.name}`,
      normalizedName: (a.name || a.email).toLowerCase(),
      metadata: { email: a.email, commitCount: a.commitCount },
    }))
    const inserted = await db
      .insert(entities)
      .values(personRows)
      .onConflictDoNothing()
      .returning({ id: entities.id, qualifiedName: entities.qualifiedName })
    for (const row of inserted) {
      if (row.qualifiedName) {
        for (const [key, a] of personByKey) {
          if (`person::${a.email || a.name}` === row.qualifiedName) {
            personIdByKey.set(key, row.id)
          }
        }
      }
    }
    // If onConflictDoNothing skipped a row (rerun), re-fetch:
    if (personIdByKey.size < history.authors.length) {
      const fetched = await db
        .select({
          id: entities.id,
          qualifiedName: entities.qualifiedName,
        })
        .from(entities)
        .where(
          inArray(
            entities.qualifiedName,
            personRows.map((p) => p.qualifiedName),
          ),
        )
      for (const row of fetched) {
        if (!row.qualifiedName) continue
        for (const [key, a] of personByKey) {
          if (`person::${a.email || a.name}` === row.qualifiedName) {
            personIdByKey.set(key, row.id)
          }
        }
      }
    }
  }

  // Insert commit entities + authored/modified_by relations.
  const commitRows: typeof entities.$inferInsert[] = history.commits.map(
    (c: GitCommit) => ({
      workspaceId,
      type: 'commit' as const,
      name: c.sha.slice(0, 7),
      qualifiedName: `commit::${c.sha}`,
      normalizedName: c.sha,
      metadata: {
        sha: c.sha,
        author: c.authorName,
        email: c.authorEmail,
        date: c.date.toISOString(),
        message: c.message,
        filesChanged: c.filesChanged,
      },
    }),
  )

  const insertedCommits = await db
    .insert(entities)
    .values(commitRows)
    .onConflictDoNothing()
    .returning({ id: entities.id, qualifiedName: entities.qualifiedName })
  const commitIdBySha = new Map<string, string>()
  for (const row of insertedCommits) {
    if (row.qualifiedName) {
      const sha = row.qualifiedName.replace(/^commit::/, '')
      commitIdBySha.set(sha, row.id)
    }
  }

  // Build relations.
  const relRows: typeof relations.$inferInsert[] = []
  for (const c of history.commits) {
    const commitId = commitIdBySha.get(c.sha)
    if (!commitId) continue
    const personKey = `${c.authorName}::${c.authorEmail}`.toLowerCase()
    const personId = personIdByKey.get(personKey)
    if (personId) {
      relRows.push({
        workspaceId,
        fromEntityId: personId,
        toEntityId: commitId,
        type: 'authored',
      })
    }
    for (const file of c.filesChanged) {
      const fileId = fileIdByPath.get(file)
      if (fileId) {
        relRows.push({
          workspaceId,
          fromEntityId: commitId,
          toEntityId: fileId,
          type: 'modified_by',
          sourceCommitSha: c.sha,
        })
      }
    }
  }

  if (relRows.length > 0) {
    const BATCH = 500
    for (let i = 0; i < relRows.length; i += BATCH) {
      await db.insert(relations).values(relRows.slice(i, i + BATCH))
    }
  }

  return history.commits.length
}
