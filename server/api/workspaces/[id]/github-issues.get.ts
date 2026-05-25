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
 * Linking + ranking: delegates to the shared github-issue-linking
 * helper (also used by the list_issues KAG operator), then adds a
 * REST-endpoint-specific difficulty score + sort.
 */
import { Octokit } from '@octokit/rest'
import { eq } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { workspaces } from '../../../db/schema'
import {
  excerptIssueBody,
  extractRefs,
  lookupEntitiesByRefs,
  type LinkedEntity,
} from '../../../lib/github-issue-linking'
import { readAccess } from '../../../lib/workspace-access'

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

  // Drop PRs — GitHub's issues endpoint returns them too.
  const issuesOnly = raw.filter((i) => !('pull_request' in i && i.pull_request))
  if (issuesOnly.length === 0) return { issues: [] }

  // Collect refs once for a single entity lookup across all issues.
  const allRefs = new Set<string>()
  const refsPerIssue = new Map<number, Set<string>>()
  for (const i of issuesOnly) {
    const refs = extractRefs(`${i.title}\n${i.body ?? ''}`)
    refsPerIssue.set(i.number, refs)
    for (const r of refs) allRefs.add(r)
  }
  const entityMatches = allRefs.size > 0
    ? await lookupEntitiesByRefs(db, workspaceId, [...allRefs])
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

  // Most actionable first: linked > unlinked, then by score asc.
  out.sort((a, b) => {
    if ((a.relatedEntities.length > 0) !== (b.relatedEntities.length > 0)) {
      return a.relatedEntities.length > 0 ? -1 : 1
    }
    return a.difficultyScore - b.difficultyScore
  })

  return { issues: out.slice(0, 12) }
})
