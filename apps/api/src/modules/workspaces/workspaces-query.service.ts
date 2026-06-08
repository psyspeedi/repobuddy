import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { Octokit } from '@octokit/rest'
import { and, desc, eq, ilike, inArray, isNotNull, ne, not, or, sql } from 'drizzle-orm'
import { chunks, entities, entityChunks, relations, workspaces } from '#server/db/schema'
import {
  excerptIssueBody,
  extractRefs,
  lookupEntitiesByRefs,
  type LinkedEntity,
} from '#server/lib/github-issue-linking'
import { getProjectOverview } from '#server/lib/project-overview'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'

const SEARCH_DEFAULT_LIMIT = 20
const GRAPH_DEFAULT_LIMIT = 2000
const GRAPH_NEIGHBOR_LIMIT = 1500
const GH_URL_RE = /github\.com\/([^/]+)\/([^/.]+)/
const TARGET_LABELS = [
  'good first issue',
  'good-first-issue',
  'help wanted',
  'help-wanted',
  'documentation',
]

interface FirstIssue {
  number: number
  title: string
  url: string
  bodyExcerpt: string
  labels: string[]
  author: string | null
  updatedAt: string
  relatedEntities: LinkedEntity[]
  difficulty: 'easy' | 'medium' | 'hard'
  difficultyScore: number
}

interface SetupStep {
  kind: 'install' | 'env' | 'run' | 'test' | 'docker' | 'note'
  label: string
  command: string | null
  source: string
}

interface SetupGuide {
  steps: SetupStep[]
  signals: {
    packageManager: 'pnpm' | 'yarn' | 'npm' | 'bun' | null
    hasDocker: boolean
    hasDockerCompose: boolean
    hasMakefile: boolean
    hasPyproject: boolean
    hasGoMod: boolean
    hasCargoToml: boolean
  }
  readmeQuickStart: string | null
}

interface TreemapNode {
  name: string
  path: string
  children?: TreemapNode[]
  value?: number
  meta?: {
    entityCount: number
    hotness: number
    hasTests: boolean
    entityId: string
  }
}

@Injectable()
export class WorkspacesQueryService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async searchEntities(workspaceId: string, q: string, limit: number) {
    const trimmed = q.trim()
    if (!trimmed) return { results: [] }
    const cap = Math.min(limit, 50)
    const rows = await this.db
      .select({
        id: entities.id,
        type: entities.type,
        name: entities.name,
        qualifiedName: entities.qualifiedName,
        filePath: entities.filePath,
      })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          ilike(entities.normalizedName, `%${trimmed.toLowerCase()}%`),
        ),
      )
      .limit(cap * 2)

    const lowered = trimmed.toLowerCase()
    rows.sort((a, b) => {
      const ax = a.name.toLowerCase() === lowered ? 0 : 1
      const bx = b.name.toLowerCase() === lowered ? 0 : 1
      if (ax !== bx) return ax - bx
      return a.name.length - b.name.length
    })
    return { results: rows.slice(0, cap) }
  }

  async getChunkById(workspaceId: string, chunkId: string) {
    const [chunk] = await this.db
      .select()
      .from(chunks)
      .where(and(eq(chunks.id, chunkId), eq(chunks.workspaceId, workspaceId)))
      .limit(1)
    if (!chunk) throw new NotFoundException('chunk not found')
    return { chunk }
  }

  async getChunkByPath(workspaceId: string, path: string | null, excludeId: string | null) {
    if (!path) return { chunk: null }
    const conds = [
      eq(chunks.workspaceId, workspaceId),
      eq(chunks.filePath, path),
      not(sql`coalesce(${chunks.metadata}->>'kind','') = 'diff'`),
    ]
    if (excludeId) conds.push(ne(chunks.id, excludeId))
    const [row] = await this.db
      .select()
      .from(chunks)
      .where(and(...conds))
      .orderBy(desc(chunks.createdAt))
      .limit(1)
    return { chunk: row ?? null }
  }

  async getEntityDetails(workspaceId: string, entityId: string) {
    const [entity] = await this.db
      .select()
      .from(entities)
      .where(and(eq(entities.workspaceId, workspaceId), eq(entities.id, entityId)))
      .limit(1)
    if (!entity) throw new NotFoundException('entity not found')

    const incomingRows = await this.db
      .select({
        id: relations.id,
        type: relations.type,
        entity: {
          id: entities.id,
          name: entities.name,
          type: entities.type,
          qualifiedName: entities.qualifiedName,
          filePath: entities.filePath,
        },
      })
      .from(relations)
      .innerJoin(entities, eq(entities.id, relations.fromEntityId))
      .where(and(eq(relations.workspaceId, workspaceId), eq(relations.toEntityId, entityId)))
      .limit(200)

    const outgoingRows = await this.db
      .select({
        id: relations.id,
        type: relations.type,
        entity: {
          id: entities.id,
          name: entities.name,
          type: entities.type,
          qualifiedName: entities.qualifiedName,
          filePath: entities.filePath,
        },
      })
      .from(relations)
      .innerJoin(entities, eq(entities.id, relations.toEntityId))
      .where(and(eq(relations.workspaceId, workspaceId), eq(relations.fromEntityId, entityId)))
      .limit(200)

    const filesChanged =
      entity.type === 'commit' ? await this.resolveCommitFiles(workspaceId, entity) : null

    const linkedChunks = await this.db
      .select({
        id: chunks.id,
        filePath: chunks.filePath,
        startLine: chunks.startLine,
        endLine: chunks.endLine,
        sourceType: chunks.sourceType,
      })
      .from(chunks)
      .innerJoin(entityChunks, eq(entityChunks.chunkId, chunks.id))
      .where(eq(entityChunks.entityId, entityId))
      .limit(20)

    return {
      entity,
      incoming: incomingRows,
      outgoing: outgoingRows,
      filesChanged,
      linkedChunks,
      counts: { incoming: incomingRows.length, outgoing: outgoingRows.length },
    }
  }

  private async resolveCommitFiles(
    workspaceId: string,
    commitEntity: typeof entities.$inferSelect,
  ): Promise<{ id: string | null; path: string }[]> {
    const meta = commitEntity.metadata as { filesChanged?: string[] } | null
    const paths = Array.isArray(meta?.filesChanged) ? meta!.filesChanged : []
    if (paths.length === 0) return []
    const fileRows = await this.db
      .select({ id: entities.id, filePath: entities.filePath })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          eq(entities.type, 'file'),
          inArray(entities.filePath, paths),
        ),
      )
    const byPath = new Map<string, string>()
    for (const r of fileRows) if (r.filePath) byPath.set(r.filePath, r.id)
    return paths.map((p) => ({ id: byPath.get(p) ?? null, path: p }))
  }

  async getEntityNeighbours(
    workspaceId: string,
    entityId: string,
    depth: number,
    perDirLimit: number,
  ) {
    const d = Math.min(Math.max(depth, 1), 2)
    const cap = Math.min(Math.max(perDirLimit, 10), 200)
    const visited = new Set<string>([entityId])
    let ring = new Set<string>([entityId])
    const edges: Array<{ id: string; from: string; to: string; type: string }> = []
    const distance = new Map<string, number>([[entityId, 0]])

    for (let hop = 1; hop <= d && ring.size > 0; hop++) {
      const ids = [...ring]
      const rows = await this.db
        .select({
          id: relations.id,
          from: relations.fromEntityId,
          to: relations.toEntityId,
          type: relations.type,
        })
        .from(relations)
        .where(
          and(
            eq(relations.workspaceId, workspaceId),
            or(inArray(relations.fromEntityId, ids), inArray(relations.toEntityId, ids))!,
          ),
        )
        .limit(cap * Math.max(1, ids.length))
      const nextRing = new Set<string>()
      for (const r of rows) {
        edges.push(r)
        for (const peer of [r.from, r.to]) {
          if (!visited.has(peer)) {
            visited.add(peer)
            distance.set(peer, hop)
            nextRing.add(peer)
          }
        }
      }
      ring = nextRing
    }

    const nodeRows = await this.db
      .select({
        id: entities.id,
        type: entities.type,
        name: entities.name,
        qualifiedName: entities.qualifiedName,
        filePath: entities.filePath,
        startLine: entities.startLine,
        endLine: entities.endLine,
        language: entities.language,
      })
      .from(entities)
      .where(and(eq(entities.workspaceId, workspaceId), inArray(entities.id, [...visited])))

    const center = nodeRows.find((n) => n.id === entityId)
    if (!center) throw new NotFoundException('entity not found')

    return {
      center,
      nodes: nodeRows.map((n) => ({ ...n, depth: distance.get(n.id) ?? d })),
      edges,
    }
  }

  async getGraph(
    workspaceId: string,
    opts: { limit: number; typeFilter?: string[]; langFilter?: string[]; includeNeighbors: boolean },
  ) {
    const limit = Math.min(opts.limit, 5000)

    const primaryRows = await this.db
      .select({
        id: entities.id,
        type: entities.type,
        name: entities.name,
        qualifiedName: entities.qualifiedName,
        language: entities.language,
        filePath: entities.filePath,
        metadata: entities.metadata,
      })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          opts.typeFilter ? inArray(entities.type, opts.typeFilter) : undefined,
          opts.langFilter ? inArray(entities.language, opts.langFilter) : undefined,
        ),
      )
      .limit(limit)

    const primaryIds = new Set(primaryRows.map((n) => n.id))
    const primaryIdsArr = [...primaryIds]
    let allEdges: { id: string; fromEntityId: string; toEntityId: string; type: string }[] = []
    if (primaryIdsArr.length > 0) {
      allEdges = await this.db
        .select({
          id: relations.id,
          fromEntityId: relations.fromEntityId,
          toEntityId: relations.toEntityId,
          type: relations.type,
        })
        .from(relations)
        .where(
          and(
            eq(relations.workspaceId, workspaceId),
            or(
              inArray(relations.fromEntityId, primaryIdsArr),
              inArray(relations.toEntityId, primaryIdsArr),
            ),
          ),
        )
        .limit(limit * 4)
    }

    const contextIds = new Set<string>()
    if (opts.includeNeighbors) {
      for (const e of allEdges) {
        if (!primaryIds.has(e.fromEntityId)) contextIds.add(e.fromEntityId)
        if (!primaryIds.has(e.toEntityId)) contextIds.add(e.toEntityId)
        if (contextIds.size >= GRAPH_NEIGHBOR_LIMIT) break
      }
    }

    const contextRows =
      contextIds.size === 0
        ? []
        : await this.db
            .select({
              id: entities.id,
              type: entities.type,
              name: entities.name,
              qualifiedName: entities.qualifiedName,
              language: entities.language,
              filePath: entities.filePath,
              metadata: entities.metadata,
            })
            .from(entities)
            .where(inArray(entities.id, [...contextIds]))

    const allNodes = [
      ...primaryRows.map((r) => ({ ...r, isContext: false })),
      ...contextRows.map((r) => ({ ...r, isContext: true })),
    ]
    const visibleIds = new Set(allNodes.map((n) => n.id))
    const edgeRows = allEdges.filter(
      (e) => visibleIds.has(e.fromEntityId) && visibleIds.has(e.toEntityId),
    )

    const stats = await this.db
      .select({ type: entities.type, count: sql<number>`count(*)::int` })
      .from(entities)
      .where(eq(entities.workspaceId, workspaceId))
      .groupBy(entities.type)

    return {
      nodes: allNodes,
      edges: edgeRows,
      truncated: primaryRows.length === limit,
      stats,
      counts: {
        primary: primaryRows.length,
        context: contextRows.length,
        edges: edgeRows.length,
      },
    }
  }

  async getOnboarding(workspaceId: string) {
    const overview = await getProjectOverview(this.db, workspaceId)
    return {
      entrypoints: overview.entrypoints,
      coreAbstractions: overview.coreAbstractions,
      goodFirstIssues: overview.goodFirstIssues,
    }
  }

  async getTreemap(workspaceId: string) {
    const fileRows = await this.db
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

    if (fileRows.length === 0) {
      return { root: { name: 'root', path: '', children: [] }, totalFiles: 0 }
    }

    const counts = await this.db.execute<{ file_path: string; n: number }>(sql`
      SELECT file_path, count(*)::int AS n
      FROM ${entities}
      WHERE workspace_id = ${workspaceId} AND file_path IS NOT NULL
      GROUP BY file_path
    `)
    const countByPath = new Map<string, number>()
    for (const r of counts) countByPath.set(r.file_path, Number(r.n))

    const tested = await this.db.execute<{ file_path: string }>(sql`
      SELECT DISTINCT e.file_path
      FROM ${entities} e
      INNER JOIN ${relations} r ON r.from_entity_id = e.id AND r.type = 'tested_by'
      WHERE e.workspace_id = ${workspaceId} AND e.file_path IS NOT NULL
    `)
    const coveredPaths = new Set<string>(tested.map((r) => r.file_path))

    interface FileRow {
      id: string
      path: string
      entityCount: number
      hotness: number
      hasTests: boolean
    }
    const files: FileRow[] = fileRows
      .filter((f) => f.filePath != null)
      .map((f) => {
        const meta = (f.metadata as { hotness?: number } | null) ?? null
        return {
          id: f.id,
          path: f.filePath as string,
          entityCount: countByPath.get(f.filePath as string) ?? 1,
          hotness: meta?.hotness ?? 0,
          hasTests: coveredPaths.has(f.filePath as string),
        }
      })

    const root: TreemapNode = { name: workspaceId.slice(0, 8), path: '', children: [] }
    for (const f of files) {
      const segments = f.path.split('/').filter(Boolean)
      let cursor = root
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i] as string
        cursor.children = cursor.children ?? []
        let next = cursor.children.find((c) => c.name === seg && !c.value)
        if (!next) {
          next = { name: seg, path: segments.slice(0, i + 1).join('/'), children: [] }
          cursor.children.push(next)
        }
        cursor = next
      }
      cursor.children = cursor.children ?? []
      cursor.children.push({
        name: segments[segments.length - 1] ?? f.path,
        path: f.path,
        value: f.entityCount,
        meta: {
          entityCount: f.entityCount,
          hotness: f.hotness,
          hasTests: f.hasTests,
          entityId: f.id,
        },
      })
    }
    return { root, totalFiles: files.length }
  }

  async buildSetupGuide(workspaceId: string): Promise<SetupGuide> {
    const signalFiles = await this.db
      .select({ filePath: chunks.filePath, text: chunks.text })
      .from(chunks)
      .where(
        and(
          eq(chunks.workspaceId, workspaceId),
          sql`(
            ${chunks.filePath} LIKE '%package.json'
            OR ${chunks.filePath} LIKE '%pyproject.toml'
            OR ${chunks.filePath} LIKE '%/Makefile'
            OR ${chunks.filePath} = 'Makefile'
            OR ${chunks.filePath} LIKE '%/Dockerfile'
            OR ${chunks.filePath} = 'Dockerfile'
            OR lower(${chunks.filePath}) LIKE '%docker-compose%'
            OR lower(${chunks.filePath}) LIKE '%readme%'
            OR ${chunks.filePath} = 'go.mod'
            OR ${chunks.filePath} LIKE '%/go.mod'
            OR ${chunks.filePath} = 'Cargo.toml'
          )`,
        ),
      )
      .orderBy(sql`length(${chunks.filePath}) ASC`)
      .limit(80)

    const guide: SetupGuide = {
      steps: [],
      signals: {
        packageManager: null,
        hasDocker: false,
        hasDockerCompose: false,
        hasMakefile: false,
        hasPyproject: false,
        hasGoMod: false,
        hasCargoToml: false,
      },
      readmeQuickStart: null,
    }

    let topPackageJson: { path: string; text: string } | null = null
    let topPyproject: { path: string; text: string } | null = null
    let topMakefile: { path: string; text: string } | null = null
    let readmeText: { path: string; text: string } | null = null

    for (const c of signalFiles) {
      const path = c.filePath ?? ''
      const depth = path.split('/').length
      const text = c.text
      if (path.endsWith('package.json')) {
        if (!topPackageJson || depth < topPackageJson.path.split('/').length) {
          topPackageJson = { path, text }
        }
      } else if (path.endsWith('pyproject.toml')) {
        guide.signals.hasPyproject = true
        if (!topPyproject || depth < topPyproject.path.split('/').length) {
          topPyproject = { path, text }
        }
      } else if (path.endsWith('Makefile') || path === 'Makefile') {
        guide.signals.hasMakefile = true
        if (!topMakefile || depth < topMakefile.path.split('/').length) {
          topMakefile = { path, text }
        }
      } else if (path.endsWith('Dockerfile') || path === 'Dockerfile') {
        guide.signals.hasDocker = true
      } else if (path.toLowerCase().includes('docker-compose')) {
        guide.signals.hasDockerCompose = true
      } else if (path === 'go.mod' || path.endsWith('/go.mod')) {
        guide.signals.hasGoMod = true
      } else if (path === 'Cargo.toml') {
        guide.signals.hasCargoToml = true
      } else if (path.toLowerCase().includes('readme')) {
        if (!readmeText || depth < readmeText.path.split('/').length) {
          readmeText = { path, text }
        }
      }
    }

    if (topPackageJson) {
      try {
        const pkg = JSON.parse(topPackageJson.text) as {
          scripts?: Record<string, string>
          packageManager?: string
        }
        const pm = detectPackageManager(pkg)
        guide.signals.packageManager = pm
        guide.steps.push({
          kind: 'install',
          label: 'Install dependencies',
          command: `${pm} install`,
          source: topPackageJson.path,
        })
        const scripts = pkg.scripts ?? {}
        const devScript = pickScript(scripts, ['dev', 'start', 'serve'])
        if (devScript) {
          guide.steps.push({
            kind: 'run',
            label: 'Run the app',
            command: `${pm} ${pmRunPrefix(pm)} ${devScript}`,
            source: topPackageJson.path,
          })
        }
        const testScript = pickScript(scripts, ['test', 'test:unit'])
        if (testScript) {
          guide.steps.push({
            kind: 'test',
            label: 'Run tests',
            command: `${pm} ${pmRunPrefix(pm)} ${testScript}`,
            source: topPackageJson.path,
          })
        }
      } catch {
        /* malformed package.json — skip silently */
      }
    }

    if (topPyproject && !topPackageJson) {
      const hasPoetry = topPyproject.text.includes('[tool.poetry]')
      const hasUv = topPyproject.text.includes('[tool.uv]') || topPyproject.text.includes('uv.lock')
      const installCmd = hasPoetry ? 'poetry install' : hasUv ? 'uv sync' : 'pip install -e .'
      guide.steps.push({
        kind: 'install',
        label: 'Install dependencies',
        command: installCmd,
        source: topPyproject.path,
      })
      const scriptMatch = topPyproject.text.match(/\[project\.scripts\]([\s\S]*?)(?=\n\[|\n*$)/)
      if (scriptMatch && scriptMatch[1]) {
        const firstScript = scriptMatch[1].match(/^\s*([a-zA-Z0-9_-]+)\s*=/m)
        if (firstScript && firstScript[1]) {
          guide.steps.push({
            kind: 'run',
            label: 'Run the CLI',
            command: hasPoetry ? `poetry run ${firstScript[1]}` : firstScript[1],
            source: topPyproject.path,
          })
        }
      }
    }

    if (guide.signals.hasGoMod && !topPackageJson) {
      guide.steps.push({ kind: 'install', label: 'Fetch dependencies', command: 'go mod download', source: 'go.mod' })
      guide.steps.push({ kind: 'run', label: 'Build & run', command: 'go run ./...', source: 'go.mod' })
    }

    if (guide.signals.hasCargoToml && !topPackageJson) {
      guide.steps.push({ kind: 'install', label: 'Build dependencies', command: 'cargo build', source: 'Cargo.toml' })
      guide.steps.push({ kind: 'run', label: 'Run', command: 'cargo run', source: 'Cargo.toml' })
    }

    if (guide.signals.hasDockerCompose) {
      guide.steps.unshift({
        kind: 'docker',
        label: 'Or use Docker Compose',
        command: 'docker compose up',
        source: 'docker-compose.yml',
      })
    }

    if (topMakefile) {
      const targets = extractMakeTargets(topMakefile.text).slice(0, 5)
      if (targets.length > 0) {
        guide.steps.push({
          kind: 'note',
          label: 'Makefile targets',
          command: targets.map((t) => `make ${t}`).join('   '),
          source: topMakefile.path,
        })
      }
    }

    if (readmeText) {
      guide.readmeQuickStart = extractReadmeQuickStart(readmeText.text)
    }
    return guide
  }

  async getFirstIssues(workspaceId: string): Promise<{ issues: FirstIssue[]; reason?: string }> {
    const ws = await this.db
      .select({ sourceUrl: workspaces.sourceUrl })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    const sourceUrl = ws[0]?.sourceUrl
    if (!sourceUrl) return { issues: [], reason: 'no_source_url' }
    const match = sourceUrl.match(GH_URL_RE)
    if (!match) return { issues: [], reason: 'not_github' }
    const owner = match[1] as string
    const repo = match[2] as string

    const octokit = new Octokit()
    let raw: Awaited<ReturnType<typeof octokit.rest.issues.listForRepo>>['data']
    try {
      const res = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: 'open',
        labels: TARGET_LABELS.join(','),
        per_page: 30,
        sort: 'updated',
        direction: 'desc',
      })
      raw = res.data
      if (raw.length === 0) {
        const fallback = await octokit.rest.issues.listForRepo({
          owner,
          repo,
          state: 'open',
          per_page: 30,
          sort: 'updated',
          direction: 'desc',
        })
        raw = fallback.data
      }
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0
      return {
        issues: [],
        reason: status === 403 ? 'rate_limited' : status === 404 ? 'repo_not_found' : 'fetch_failed',
      }
    }

    const issuesOnly = raw.filter((i) => !('pull_request' in i && i.pull_request))
    if (issuesOnly.length === 0) return { issues: [] }

    const allRefs = new Set<string>()
    const refsPerIssue = new Map<number, Set<string>>()
    for (const i of issuesOnly) {
      const refs = extractRefs(`${i.title}\n${i.body ?? ''}`)
      refsPerIssue.set(i.number, refs)
      for (const r of refs) allRefs.add(r)
    }
    const entityMatches =
      allRefs.size > 0
        ? await lookupEntitiesByRefs(this.db, workspaceId, [...allRefs])
        : new Map<string, LinkedEntity[]>()

    const out: FirstIssue[] = issuesOnly.map((i) => {
      const refs = refsPerIssue.get(i.number) ?? new Set<string>()
      const linked = new Map<string, LinkedEntity>()
      for (const r of refs) {
        const hits = entityMatches.get(r.toLowerCase()) ?? []
        for (const e of hits) linked.set(e.entityId, e)
      }
      const related = [...linked.values()].slice(0, 5)
      const score = related.reduce((acc, e) => acc + e.inDegree, 0) + related.length
      const difficulty: 'easy' | 'medium' | 'hard' =
        score === 0 ? 'easy' : score < 6 ? 'easy' : score < 20 ? 'medium' : 'hard'
      return {
        number: i.number,
        title: i.title,
        url: i.html_url,
        bodyExcerpt: excerptIssueBody(i.body ?? ''),
        labels: (i.labels ?? [])
          .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
          .filter(Boolean),
        author: i.user?.login ?? null,
        updatedAt: i.updated_at,
        relatedEntities: related,
        difficulty,
        difficultyScore: score,
      }
    })

    out.sort((a, b) => {
      if ((a.relatedEntities.length > 0) !== (b.relatedEntities.length > 0)) {
        return a.relatedEntities.length > 0 ? -1 : 1
      }
      return a.difficultyScore - b.difficultyScore
    })

    return { issues: out.slice(0, 12) }
  }
}

function detectPackageManager(pkg: { packageManager?: string }): 'pnpm' | 'yarn' | 'npm' | 'bun' {
  if (pkg.packageManager?.startsWith('pnpm')) return 'pnpm'
  if (pkg.packageManager?.startsWith('yarn')) return 'yarn'
  if (pkg.packageManager?.startsWith('bun')) return 'bun'
  return 'npm'
}

function pmRunPrefix(pm: 'pnpm' | 'yarn' | 'npm' | 'bun'): string {
  return pm === 'pnpm' ? '' : 'run'
}

function pickScript(scripts: Record<string, string>, candidates: string[]): string | null {
  for (const c of candidates) if (scripts[c]) return c
  return null
}

function extractMakeTargets(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/)
    if (m && m[1] && m[1] !== '.PHONY' && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

function extractReadmeQuickStart(md: string): string | null {
  const headingRe = /^#{1,3}\s+(.+)$/gm
  const heads = [...md.matchAll(headingRe)]
  if (heads.length === 0) return null
  const wanted = /^(install|installation|quick.?start|getting.?started|setup|usage|development|running.?locally)/i
  const targetIdx = heads.findIndex((h) => wanted.test((h[1] ?? '').trim()))
  if (targetIdx < 0) return null
  const target = heads[targetIdx]
  if (!target || target.index === undefined) return null
  const next = heads[targetIdx + 1]
  const start = target.index + target[0].length
  const end = next?.index ?? Math.min(md.length, start + 800)
  return md.slice(start, end).trim().slice(0, 800)
}

export { SEARCH_DEFAULT_LIMIT, GRAPH_DEFAULT_LIMIT }
