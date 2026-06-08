/**
 * Project overview — entrypoints, core abstractions, hot files,
 * safe-first-PR zones, and aggregate stats. Single source of truth
 * shared by:
 *   - the Tour-overlay endpoint (server/api/workspaces/[id]/onboarding.get.ts)
 *   - the KAG `get_project_overview` operator
 *
 * No LLM cost. One small fan-out of SQL queries (5-7), all using
 * indexed columns. Safe to call from the chat planner.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { chunks, entities, relations } from '../db/schema'

export type EntrypointKind =
  | 'main'
  | 'cli'
  | 'http_route'
  | 'python_main'
  | 'readme_quickstart'

export interface EntrypointHit {
  /** Canonical id (or null if we found a manifest entry that doesn't
   * resolve to a file entity — e.g. package.json says "main: dist/x.js"
   * but the file isn't indexed). */
  id: string | null
  /** Legacy alias used by the Tour overlay UI. */
  entityId: string | null
  name: string
  filePath: string
  kind: EntrypointKind
  description: string
}

export interface CoreAbstraction {
  id: string
  entityId: string
  name: string
  type: string
  qualifiedName: string | null
  filePath: string | null
  inDegree: number
  description: string | null
}

export interface FirstIssueZone {
  id: string
  entityId: string
  filePath: string
  score: number
  reasons: string[]
  hotness: number
  entityCount: number
  hasTests: boolean
}

export interface HotFile {
  id: string
  entityId: string
  filePath: string
  hotness: number
}

export interface ContribGuideExcerpt {
  /** Relative path of the source file. */
  filePath: string
  /** Identifies which template family this is (so UI/LLM can label it). */
  kind: 'contributing' | 'pr_template' | 'issue_template' | 'code_of_conduct' | 'security'
  /** First ~1.5KB of text — enough to surface the rules without bloating prompts. */
  excerpt: string
}

export interface ProjectOverview {
  entrypoints: EntrypointHit[]
  coreAbstractions: CoreAbstraction[]
  goodFirstIssues: FirstIssueZone[]
  hotFiles: HotFile[]
  /** CONTRIBUTING / PR template / issue template / CoC content. */
  contribGuide: ContribGuideExcerpt[]
  /** Mermaid `flowchart LR` of top-level folders + cross-folder imports.
   * Empty when the repo is too flat for a meaningful diagram. */
  architectureMermaid: string | null
  stats: {
    entitiesByType: Record<string, number>
    totalFiles: number
    totalEntities: number
  }
}

/**
 * Build a complete project overview in one fan-out. Caller passes the
 * Drizzle db handle so the operator can share the connection with the
 * rest of its plan and the Tour endpoint can stay on its existing
 * runtime-config-derived connection.
 */
export async function getProjectOverview(
  db: Database,
  workspaceId: string,
): Promise<ProjectOverview> {
  const [
    entrypoints,
    coreAbstractions,
    goodFirstIssues,
    hotFiles,
    contribGuide,
    architectureMermaid,
    stats,
  ] = await Promise.all([
    findEntrypoints(db, workspaceId),
    findCoreAbstractions(db, workspaceId),
    findGoodFirstIssues(db, workspaceId),
    findHotFiles(db, workspaceId),
    findContribGuide(db, workspaceId),
    buildArchitectureMermaid(db, workspaceId),
    computeStats(db, workspaceId),
  ])
  return { entrypoints, coreAbstractions, goodFirstIssues, hotFiles, contribGuide, architectureMermaid, stats }
}

/**
 * Auto-generated `flowchart LR` mermaid diagram of top-level folder
 * dependencies. Picks top-N folders by entity count (depth ≤ 2 from
 * root), counts inbound/outbound import edges between them. Output is
 * pure text — caller (Tour UI or answer prompt) decides how to render.
 */
async function buildArchitectureMermaid(
  db: Database,
  workspaceId: string,
): Promise<string | null> {
  // 1. Top folders by entity count.
  const folders = await db.execute<{ folder: string; n: number }>(sql`
    SELECT
      coalesce(
        nullif(substring(file_path from '^([^/]+/[^/]+)(/|$)'), ''),
        nullif(substring(file_path from '^([^/]+)(/|$)'), ''),
        '(root)'
      ) AS folder,
      count(*)::int AS n
    FROM ${entities}
    WHERE workspace_id = ${workspaceId} AND file_path IS NOT NULL
    GROUP BY folder
    HAVING count(*) >= 3
    ORDER BY n DESC
    LIMIT 12
  `)
  if (folders.length < 2) return null

  // 2. Folder-folder import edges. Group `imports` relations by the
  // folder of their from-entity and to-entity. Self-folder edges
  // dropped (noise).
  const edges = await db.execute<{ from_folder: string; to_folder: string; n: number }>(sql`
    SELECT
      coalesce(
        nullif(substring(fe.file_path from '^([^/]+/[^/]+)(/|$)'), ''),
        nullif(substring(fe.file_path from '^([^/]+)(/|$)'), ''),
        '(root)'
      ) AS from_folder,
      coalesce(
        nullif(substring(te.file_path from '^([^/]+/[^/]+)(/|$)'), ''),
        nullif(substring(te.file_path from '^([^/]+)(/|$)'), ''),
        '(root)'
      ) AS to_folder,
      count(*)::int AS n
    FROM ${relations} r
    INNER JOIN ${entities} fe ON fe.id = r.from_entity_id
    INNER JOIN ${entities} te ON te.id = r.to_entity_id
    WHERE r.workspace_id = ${workspaceId}
      AND r.type = 'imports'
      AND fe.file_path IS NOT NULL
      AND te.file_path IS NOT NULL
    GROUP BY from_folder, to_folder
    HAVING count(*) >= 2
    ORDER BY n DESC
    LIMIT 40
  `)

  const folderSet = new Set(folders.map((f) => f.folder))
  const sanitise = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32) || 'node'
  const lines: string[] = ['flowchart LR']
  for (const f of folders) {
    const id = sanitise(f.folder)
    lines.push(`    ${id}["${f.folder}<br/>${f.n}"]`)
  }
  let edgesAdded = 0
  for (const e of edges) {
    if (e.from_folder === e.to_folder) continue
    if (!folderSet.has(e.from_folder) || !folderSet.has(e.to_folder)) continue
    const from = sanitise(e.from_folder)
    const to = sanitise(e.to_folder)
    lines.push(`    ${from} -->|${e.n}| ${to}`)
    edgesAdded += 1
    if (edgesAdded >= 25) break
  }
  if (edgesAdded === 0) return null
  return lines.join('\n')
}

const CONTRIB_PATTERNS: { re: RegExp; kind: ContribGuideExcerpt['kind'] }[] = [
  { re: /(^|\/)CONTRIBUTING(\.md|\.txt|\.rst)?$/i, kind: 'contributing' },
  { re: /(^|\/)\.github\/CONTRIBUTING(\.md)?$/i, kind: 'contributing' },
  { re: /(^|\/)\.github\/PULL_REQUEST_TEMPLATE(\.md)?$/i, kind: 'pr_template' },
  { re: /(^|\/)\.github\/PULL_REQUEST_TEMPLATE\//i, kind: 'pr_template' },
  { re: /(^|\/)\.github\/ISSUE_TEMPLATE\//i, kind: 'issue_template' },
  { re: /(^|\/)CODE_OF_CONDUCT(\.md)?$/i, kind: 'code_of_conduct' },
  { re: /(^|\/)SECURITY(\.md)?$/i, kind: 'security' },
]

async function findContribGuide(
  db: Database,
  workspaceId: string,
): Promise<ContribGuideExcerpt[]> {
  // One SQL grabs everything that LIKES the contrib-related paths.
  // We then run each path through the regex list to assign a `kind`.
  // 1500-char excerpts keep the prompt budget under control.
  const rows = await db
    .select({ filePath: chunks.filePath, text: chunks.text })
    .from(chunks)
    .where(
      and(
        eq(chunks.workspaceId, workspaceId),
        sql`(
          upper(${chunks.filePath}) LIKE '%CONTRIBUTING%'
          OR upper(${chunks.filePath}) LIKE '%PULL_REQUEST_TEMPLATE%'
          OR upper(${chunks.filePath}) LIKE '%ISSUE_TEMPLATE%'
          OR upper(${chunks.filePath}) LIKE '%CODE_OF_CONDUCT%'
          OR upper(${chunks.filePath}) LIKE '%/SECURITY.MD'
          OR upper(${chunks.filePath}) = 'SECURITY.MD'
        )`,
      ),
    )
    .orderBy(sql`length(${chunks.filePath}) ASC`)
    .limit(20)

  const out: ContribGuideExcerpt[] = []
  const seenKinds = new Map<ContribGuideExcerpt['kind'], number>()
  for (const r of rows) {
    if (!r.filePath || !r.text) continue
    const match = CONTRIB_PATTERNS.find((p) => p.re.test(r.filePath as string))
    if (!match) continue
    // Cap each kind at 2 files (root CONTRIBUTING + .github fallback, etc).
    const count = seenKinds.get(match.kind) ?? 0
    if (count >= 2) continue
    seenKinds.set(match.kind, count + 1)
    out.push({
      filePath: r.filePath,
      kind: match.kind,
      excerpt: r.text.slice(0, 1500),
    })
  }
  return out
}

async function findEntrypoints(
  db: Database,
  workspaceId: string,
): Promise<EntrypointHit[]> {
  const out: EntrypointHit[] = []

  // 1. package.json — main / bin / scripts.start. Shallowest-path-first
  // so the root manifest wins; nested workspaces / examples are picked
  // up only if no root package.json exists at all.
  const packageJsonChunks = await db
    .select({ text: chunks.text, filePath: chunks.filePath })
    .from(chunks)
    .where(
      and(
        eq(chunks.workspaceId, workspaceId),
        sql`${chunks.filePath} LIKE '%package.json'`,
      ),
    )
    .orderBy(sql`length(${chunks.filePath}) ASC`)
    .limit(10)
  const minDepth = packageJsonChunks
    .map((c) => (c.filePath?.split('/').length ?? Infinity))
    .reduce((a, b) => Math.min(a, b), Infinity)
  for (const c of packageJsonChunks) {
    if (!c.filePath) continue
    if (c.filePath.split('/').length > minDepth) continue
    try {
      const pkg = JSON.parse(c.text) as {
        name?: string
        main?: string
        bin?: string | Record<string, string>
        scripts?: Record<string, string>
      }
      if (typeof pkg.main === 'string') {
        const id = await resolveFileEntity(db, workspaceId, pkg.main)
        out.push({
          id,
          entityId: id,
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
          const id = await resolveFileEntity(db, workspaceId, target)
          out.push({
            id,
            entityId: id,
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

  // 2. Go cmd/<name>/main.go
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
      id: f.id,
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
      id: f.id,
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
      id: r.id,
      entityId: r.id,
      name: r.qualifiedName ?? r.name,
      filePath: r.filePath,
      kind: 'http_route',
      description: 'HTTP route handler',
    })
  }

  return dedupeByPathKind(out).slice(0, 8)
}

async function resolveFileEntity(
  db: Database,
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
  db: Database,
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
    id: r.id,
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
  db: Database,
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
      id: f.id,
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

async function findHotFiles(
  db: Database,
  workspaceId: string,
): Promise<HotFile[]> {
  const rows = await db.execute<{
    id: string
    file_path: string
    hotness: number
  }>(sql`
    SELECT id, file_path,
           coalesce((metadata->>'hotness')::int, 0) AS hotness
    FROM ${entities}
    WHERE workspace_id = ${workspaceId}
      AND type = 'file'
      AND file_path IS NOT NULL
      AND coalesce((metadata->>'hotness')::int, 0) > 0
    ORDER BY hotness DESC, file_path ASC
    LIMIT 10
  `)
  return rows.map((r) => ({
    id: r.id,
    entityId: r.id,
    filePath: r.file_path,
    hotness: Number(r.hotness),
  }))
}

async function computeStats(
  db: Database,
  workspaceId: string,
): Promise<ProjectOverview['stats']> {
  const rows = await db.execute<{ type: string; n: number }>(sql`
    SELECT type, count(*)::int AS n
    FROM ${entities}
    WHERE workspace_id = ${workspaceId}
    GROUP BY type
  `)
  const entitiesByType: Record<string, number> = {}
  let totalEntities = 0
  let totalFiles = 0
  for (const r of rows) {
    const n = Number(r.n)
    entitiesByType[r.type] = n
    totalEntities += n
    if (r.type === 'file') totalFiles = n
  }
  return { entitiesByType, totalFiles, totalEntities }
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
