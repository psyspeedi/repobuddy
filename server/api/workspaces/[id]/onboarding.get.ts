/**
 * Onboarding bundle for a workspace — drives the welcome overlay shown
 * to first-time visitors on /w/[id]. Three sections, all derived from
 * the existing graph + chunk text. No new tables, no LLM calls.
 *
 *   entrypoints       — package.json (main/bin), pyproject (project.scripts),
 *                       Go cmd/<name>/main.go, Python __main__.py, and
 *                       extracted `route` entities. Each tied to a real
 *                       entity so the welcome overlay can launch the
 *                       walkthrough operator on it.
 *
 *   coreAbstractions  — top-10 entities by inbound relation count (in-degree),
 *                       restricted to class/function/type/component/module.
 *                       Proxy for "what the rest of the codebase depends on".
 *
 *   goodFirstIssues   — files scored on safe-to-edit signals:
 *                         + has any `tested_by` inbound relation
 *                         + small entity count (~ small file)
 *                         + low hotness (stable, few recent commits)
 *                       Excludes test files themselves, generated code,
 *                       and obvious config. First 5 sorted by score.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { chunks, entities, relations } from '../../../db/schema'
import { readAccess } from '../../../lib/workspace-access'

interface EntrypointHit {
  entityId: string | null
  name: string
  filePath: string
  kind: 'main' | 'cli' | 'http_route' | 'python_main' | 'readme_quickstart'
  description: string
}
interface CoreAbstraction {
  entityId: string
  name: string
  type: string
  qualifiedName: string | null
  filePath: string | null
  inDegree: number
  description: string | null
}
interface FirstIssueZone {
  entityId: string
  filePath: string
  score: number
  reasons: string[]
  hotness: number
  entityCount: number
  hasTests: boolean
}

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: 'id required' })
  await readAccess(event, workspaceId)

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  const [entrypoints, coreAbstractions, goodFirstIssues] = await Promise.all([
    findEntrypoints(db, workspaceId),
    findCoreAbstractions(db, workspaceId),
    findGoodFirstIssues(db, workspaceId),
  ])

  return { entrypoints, coreAbstractions, goodFirstIssues }
})

async function findEntrypoints(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
): Promise<EntrypointHit[]> {
  const out: EntrypointHit[] = []

  // 1. package.json — main / bin / scripts.start
  const packageJsonChunks = await db
    .select({ text: chunks.text, filePath: chunks.filePath })
    .from(chunks)
    .where(
      and(
        eq(chunks.workspaceId, workspaceId),
        sql`${chunks.filePath} LIKE '%package.json'`,
      ),
    )
    .limit(10)
  for (const c of packageJsonChunks) {
    if (!c.filePath) continue
    // We only care about the top-level manifest, not nested workspaces.
    if (c.filePath.split('/').length > 2 && !c.filePath.endsWith('/package.json')) continue
    try {
      const pkg = JSON.parse(c.text) as {
        name?: string
        main?: string
        bin?: string | Record<string, string>
        scripts?: Record<string, string>
      }
      if (typeof pkg.main === 'string') {
        out.push({
          entityId: await resolveFileEntity(db, workspaceId, pkg.main),
          name: pkg.main,
          filePath: pkg.main,
          kind: 'main',
          description: `Package main from ${c.filePath}`,
        })
      }
      if (pkg.bin) {
        const bins = typeof pkg.bin === 'string'
          ? { [pkg.name ?? 'cli']: pkg.bin }
          : pkg.bin
        for (const [cmd, target] of Object.entries(bins)) {
          out.push({
            entityId: await resolveFileEntity(db, workspaceId, target),
            name: cmd,
            filePath: target,
            kind: 'cli',
            description: `CLI entrypoint \`${cmd}\``,
          })
        }
      }
    } catch {
      // malformed manifest — skip silently
    }
  }

  // 2. Go cmd/*/main.go
  const goMains = await db
    .select({ id: entities.id, filePath: entities.filePath, name: entities.name })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.type, 'file'),
        sql`${entities.filePath} ~ '(^|/)cmd/[^/]+/main\\.go$'`,
      ),
    )
    .limit(10)
  for (const f of goMains) {
    if (!f.filePath) continue
    const segs = f.filePath.split('/')
    const cmdName = segs[segs.indexOf('cmd') + 1] ?? f.name
    out.push({
      entityId: f.id,
      name: cmdName,
      filePath: f.filePath,
      kind: 'cli',
      description: `Go command \`${cmdName}\``,
    })
  }

  // 3. Python __main__.py
  const pyMains = await db
    .select({ id: entities.id, filePath: entities.filePath })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.type, 'file'),
        sql`${entities.filePath} LIKE '%/__main__.py'`,
      ),
    )
    .limit(10)
  for (const f of pyMains) {
    if (!f.filePath) continue
    const pkg = f.filePath.split('/').slice(-2, -1)[0] ?? f.filePath
    out.push({
      entityId: f.id,
      name: pkg,
      filePath: f.filePath,
      kind: 'python_main',
      description: `Python module \`python -m ${pkg}\``,
    })
  }

  // 4. HTTP routes — already extracted as `route` entities by the parser.
  const routes = await db
    .select({
      id: entities.id,
      name: entities.name,
      filePath: entities.filePath,
      qualifiedName: entities.qualifiedName,
    })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.type, 'route'),
      ),
    )
    .limit(8)
  for (const r of routes) {
    if (!r.filePath) continue
    out.push({
      entityId: r.id,
      name: r.qualifiedName ?? r.name,
      filePath: r.filePath,
      kind: 'http_route',
      description: 'HTTP route handler',
    })
  }

  return dedupeByPathKind(out).slice(0, 8)
}

/**
 * Look up the `file` entity whose path matches the given (possibly
 * relative) target. Returns null when no match — the welcome overlay
 * still shows the entry but disables the walkthrough button.
 */
async function resolveFileEntity(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  target: string,
): Promise<string | null> {
  const normalized = target.replace(/^\.?\//, '')
  const hit = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.type, 'file'),
        sql`${entities.filePath} LIKE ${'%' + normalized}`,
      ),
    )
    .limit(1)
  return hit[0]?.id ?? null
}

function dedupeByPathKind(items: EntrypointHit[]): EntrypointHit[] {
  const seen = new Set<string>()
  const out: EntrypointHit[] = []
  for (const it of items) {
    const key = `${it.kind}:${it.filePath}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

async function findCoreAbstractions(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
): Promise<CoreAbstraction[]> {
  const rows = await db.execute<{
    id: string
    name: string
    type: string
    qualified_name: string | null
    file_path: string | null
    description: string | null
    in_degree: number
  }>(sql`
    SELECT e.id, e.name, e.type, e.qualified_name, e.file_path, e.description,
           count(r.id)::int AS in_degree
    FROM ${entities} e
    LEFT JOIN ${relations} r
      ON r.to_entity_id = e.id
     AND r.workspace_id = e.workspace_id
     AND r.type IN ('calls', 'imports', 'depends_on', 'extends', 'implements', 'uses')
    WHERE e.workspace_id = ${workspaceId}
      AND e.type IN ('class', 'function', 'type', 'component', 'module')
    GROUP BY e.id
    HAVING count(r.id) > 0
    ORDER BY in_degree DESC, e.name ASC
    LIMIT 10
  `)
  return rows.map((r) => ({
    entityId: r.id,
    name: r.name,
    type: r.type,
    qualifiedName: r.qualified_name,
    filePath: r.file_path,
    description: r.description,
    inDegree: Number(r.in_degree),
  }))
}

async function findGoodFirstIssues(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
): Promise<FirstIssueZone[]> {
  const fileRows = await db
    .select({
      id: entities.id,
      filePath: entities.filePath,
      metadata: entities.metadata,
    })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.type, 'file'),
        isNotNull(entities.filePath),
      ),
    )
  if (fileRows.length === 0) return []

  const counts = await db.execute<{ file_path: string; n: number }>(sql`
    SELECT file_path, count(*)::int AS n
    FROM ${entities}
    WHERE workspace_id = ${workspaceId} AND file_path IS NOT NULL
    GROUP BY file_path
  `)
  const countByPath = new Map<string, number>()
  for (const r of counts) countByPath.set(r.file_path, Number(r.n))

  const tested = await db.execute<{ file_path: string }>(sql`
    SELECT DISTINCT e.file_path
    FROM ${entities} e
    INNER JOIN ${relations} r ON r.from_entity_id = e.id AND r.type = 'tested_by'
    WHERE e.workspace_id = ${workspaceId} AND e.file_path IS NOT NULL
  `)
  const covered = new Set<string>(tested.map((r) => r.file_path))

  const scored: FirstIssueZone[] = []
  for (const f of fileRows) {
    if (!f.filePath) continue
    if (isExcludedFromFirstIssue(f.filePath)) continue
    const entityCount = countByPath.get(f.filePath) ?? 1
    if (entityCount < 2 || entityCount > 25) continue
    const hotness = ((f.metadata as { hotness?: number } | null)?.hotness) ?? 0
    const hasTests = covered.has(f.filePath)

    const reasons: string[] = []
    let score = 0
    if (hasTests) {
      score += 3
      reasons.push('covered by tests')
    }
    if (hotness === 0) {
      score += 2
      reasons.push('stable (no recent commits)')
    } else if (hotness <= 2) {
      score += 1
      reasons.push('few recent commits')
    }
    if (entityCount <= 8) {
      score += 1
      reasons.push('small file')
    }
    if (score < 3) continue

    scored.push({
      entityId: f.id,
      filePath: f.filePath,
      score,
      reasons,
      hotness,
      entityCount,
      hasTests,
    })
  }
  scored.sort((a, b) => b.score - a.score || a.entityCount - b.entityCount)
  return scored.slice(0, 5)
}

const EXCLUDE_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /(^|\/)\.git\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)\.nuxt\//,
  /\.min\.(js|css)$/,
  /\.lock$/,
  /(^|\/)tests?\//i,
  /(^|\/)__tests?__\//,
  /\.test\.(t|j)sx?$/,
  /\.spec\.(t|j)sx?$/,
  /_test\.go$/,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)[^/]+\.config\.(t|j)s$/,
  /(^|\/)(package|tsconfig|pnpm-lock|yarn|composer)\.[a-z]+$/i,
]
function isExcludedFromFirstIssue(path: string): boolean {
  return EXCLUDE_PATTERNS.some((re) => re.test(path))
}
