/**
 * Surface GitHub issues that are good candidates for a first contribution.
 *
 * Why this lives next to the onboarding endpoint and not inside it:
 *   - It hits a remote API (GitHub), so latency is unbounded and we
 *     don't want to block the rest of the welcome overlay on it.
 *   - The result is reasonably stable per session — the UI can fire
 *     this lazily once the user actually looks at the issues tab.
 *
 * Auth: anonymous GitHub REST (60 req/hour per IP). Sufficient for the
 * small handful of fetches the welcome overlay does. If we ever hit
 * the limit we'll thread the workspace owner's OAuth token through.
 *
 * Linking: for each issue we pull out backtick-quoted tokens and
 * obvious file paths from title + body, then look up entities whose
 * `name`, `qualifiedName` or `filePath` matches. Difficulty score
 * sums in-degree of referenced entities — issues touching high-fanout
 * abstractions rate harder.
 */
import { Octokit } from '@octokit/rest'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { entities, relations, workspaces } from '../../../db/schema'
import { readAccess } from '../../../lib/workspace-access'

interface LinkedEntity {
  entityId: string
  name: string
  type: string
  filePath: string | null
  inDegree: number
}
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

const TARGET_LABELS = [
  'good first issue',
  'good-first-issue',
  'help wanted',
  'help-wanted',
  'documentation',
]

const REF_RE = /`([^`\n]{2,80})`/g
const PATH_RE = /(?<![\w/])([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|md))/g
const GH_URL_RE = /github\.com\/([^/]+)\/([^/.]+)/

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: 'id required' })
  await readAccess(event, workspaceId)

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  const ws = await db
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
    // Lots of repos don't use the canonical contributor-friendly labels.
    // Fall back to ALL open issues so the panel isn't empty just because
    // maintainers haven't tagged anything as "good first issue".
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

  // Drop PRs — GitHub's issues endpoint returns them too. PRs have a
  // pull_request field on the response object.
  const issuesOnly = raw.filter((i) => !('pull_request' in i && i.pull_request))
  if (issuesOnly.length === 0) return { issues: [] }

  // Collect candidate refs across all issues so we can do ONE entity
  // lookup instead of N round trips.
  const allRefs = new Set<string>()
  const refsPerIssue = new Map<number, Set<string>>()
  for (const i of issuesOnly) {
    const text = `${i.title}\n${i.body ?? ''}`
    const refs = extractRefs(text)
    refsPerIssue.set(i.number, refs)
    for (const r of refs) allRefs.add(r)
  }

  const entityMatches = allRefs.size > 0
    ? await lookupEntities(db, workspaceId, [...allRefs])
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
    const difficulty = score === 0 ? 'easy' : score < 6 ? 'easy' : score < 20 ? 'medium' : 'hard'
    return {
      number: i.number,
      title: i.title,
      url: i.html_url,
      bodyExcerpt: excerpt(i.body ?? ''),
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

  // Surface most actionable first: linked entities > unlinked, then by score asc (easier first).
  out.sort((a, b) => {
    if ((a.relatedEntities.length > 0) !== (b.relatedEntities.length > 0)) {
      return a.relatedEntities.length > 0 ? -1 : 1
    }
    return a.difficultyScore - b.difficultyScore
  })

  return { issues: out.slice(0, 12) }
})

function extractRefs(text: string): Set<string> {
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

function excerpt(body: string): string {
  const cleaned = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/[#*_`>]/g, '')
    .trim()
  return cleaned.length > 240 ? cleaned.slice(0, 237) + '…' : cleaned
}

async function lookupEntities(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  refs: string[],
): Promise<Map<string, LinkedEntity[]>> {
  const lower = [...new Set(refs.map((r) => r.toLowerCase()))].slice(0, 60)
  const namesOnly = lower.filter((r) => !r.includes('/'))
  const pathsOnly = lower.filter((r) => r.includes('/'))

  const out = new Map<string, LinkedEntity[]>()
  if (lower.length === 0) return out

  // 1. Entities by lowercased name / qualified_name exact match —
  // single round trip via unnest + join.
  //
  // Drizzle serialises a JS array passed as ${arr} into a row
  // constructor `($1, $2, ...)`, NOT a Postgres array literal, which
  // breaks `::text[]` ("cannot cast type record to text[]"). We build
  // the array explicitly with ARRAY[...] + sql.join so the planner
  // sees an honest text[].
  if (namesOnly.length > 0) {
    const arrayLiteral = sql`ARRAY[${sql.join(namesOnly.map((n) => sql`${n}`), sql`, `)}]::text[]`
    const rows = await db.execute<{
      id: string
      name: string
      type: string
      file_path: string | null
      lookup: string
      in_degree: number
    }>(sql`
      WITH targets AS (
        SELECT unnest(${arrayLiteral}) AS lookup
      )
      SELECT e.id, e.name, e.type, e.file_path,
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
        inDegree: Number(r.in_degree),
      })
      out.set(r.lookup, list)
    }
  }

  // 2. Path-style refs — match file entities by suffix.
  for (const p of pathsOnly) {
    const rows = await db
      .select({
        id: entities.id,
        name: entities.name,
        type: entities.type,
        filePath: entities.filePath,
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
    const ids = rows.map((r) => r.id)
    const idsArray = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`
    const degrees = await db.execute<{ to_entity_id: string; n: number }>(sql`
      SELECT to_entity_id, count(*)::int AS n
      FROM ${relations}
      WHERE workspace_id = ${workspaceId} AND to_entity_id = ANY(${idsArray})
      GROUP BY to_entity_id
    `)
    const inDegreeBy = new Map<string, number>()
    for (const d of degrees) inDegreeBy.set(d.to_entity_id, Number(d.n))
    const list = out.get(p) ?? []
    for (const r of rows) {
      list.push({
        entityId: r.id,
        name: r.name,
        type: r.type,
        filePath: r.filePath,
        inDegree: inDegreeBy.get(r.id) ?? 0,
      })
    }
    out.set(p, list)
  }

  return out
}
