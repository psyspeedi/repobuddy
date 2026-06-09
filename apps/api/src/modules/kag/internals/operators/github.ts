import { DRIZZLE_DB, type DrizzleDb } from '#modules/drizzle/drizzle.tokens'
import type { Database } from '#server/db/client'
import { Inject, Injectable } from '@nestjs/common'
import { Octokit } from '@octokit/rest'
import { sql } from 'drizzle-orm'
import { entities } from '#server/db/schema'
import type { KagOperator } from './_interface'
import {
  excerptIssueBody,
  extractRefs,
  fetchChunksForEntities,
  lookupEntitiesByRefs,
  type LinkedChunk,
  type LinkedEntity,
} from '#server/lib/github-issue-linking'
import type {
  ResolutionCommit,
  ResolutionDuplicate,
  ResolutionEnvelope,
  ResolutionPr,
} from '#shared/schemas/resolution'
import type { OperatorContext } from './_types'

// Resolution types live in shared/schemas/resolution.ts — both the
// server operator and the chat UI banner depend on them. Re-export
// here so callers can keep importing from operators/* if they prefer.
export type {
  ResolutionCommit,
  ResolutionDuplicate,
  ResolutionEnvelope,
  ResolutionPr,
  ResolutionStatus,
} from '#shared/schemas/resolution'

const KAG_GH_URL_RE = /github\.com\/([^/]+)\/([^/.]+)/

// ---------- list_issues ----------
/**
 * Fetch GitHub issues for the workspace's source repo and link them
 * back to indexed code. The envelope returned here travels into
 * answerOp, which renders the issue list with #N / labels / URL /
 * body excerpt + the matched code entities + their chunks so the
 * model can ground its answer in real source.
 *
 * Anonymous Octokit (60 req/h per IP).
 */
export interface ListIssuesParams {
  /** Optional label filter. Defaults to a broad open-issue scan. */
  labels?: string[]
  state?: 'open' | 'closed' | 'all'
  /** Cap on results. Default 15, max 30. Ignored when issueNumber set. */
  limit?: number
  /** Focus a single issue by number — answers "tell me about #42". */
  issueNumber?: number
}

export interface IssueResult {
  number: number
  title: string
  url: string
  labels: string[]
  bodyExcerpt: string
  updatedAt: string
  /** Entities the issue text mentions that exist in the graph. */
  relatedEntities: LinkedEntity[]
}

export interface IssuesEnvelope {
  /** Marker for answerOp's context loop. */
  issues: IssueResult[]
  /**
   * De-duped chunks linked to every issue's relatedEntities. answerOp
   * lifts them into the main `chunks` list so [chunk:UUID] citations
   * work in the answer.
   */
  relatedChunks: LinkedChunk[]
  /** Diagnostic — surfaced in trace, never goes into the LLM prompt. */
  reason?: 'no_source_url' | 'not_github' | 'rate_limited' | 'repo_not_found' | 'fetch_failed'
}

export async function listIssues(
  params: ListIssuesParams,
  ctx: OperatorContext,
  db: Database,
): Promise<IssuesEnvelope> {
  const sourceUrl = ctx.workspace?.sourceUrl ?? null
  if (!sourceUrl) return { issues: [], relatedChunks: [], reason: 'no_source_url' }
  const match = sourceUrl.match(KAG_GH_URL_RE)
  if (!match) return { issues: [], relatedChunks: [], reason: 'not_github' }
  const owner = match[1] as string
  const repo = match[2] as string
  const limit = Math.min(Math.max(params.limit ?? 15, 1), 30)
  const labels = params.labels && params.labels.length > 0
    ? params.labels.join(',')
    : undefined

  const octokit = new Octokit()
  let rawIssues: Awaited<ReturnType<typeof octokit.rest.issues.listForRepo>>['data']
  try {
    if (params.issueNumber) {
      const single = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: params.issueNumber,
      })
      rawIssues = [single.data] as typeof rawIssues
    } else {
      let res = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: params.state ?? 'open',
        labels,
        per_page: limit,
        sort: 'updated',
        direction: 'desc',
      })
      // Many repos don't use canonical contributor labels; fall back
      // to ALL open issues so we surface something.
      if (res.data.length === 0 && labels) {
        res = await octokit.rest.issues.listForRepo({
          owner,
          repo,
          state: params.state ?? 'open',
          per_page: limit,
          sort: 'updated',
          direction: 'desc',
        })
      }
      rawIssues = res.data
    }
  } catch (err) {
    const status = (err as { status?: number }).status ?? 0
    return {
      issues: [],
      relatedChunks: [],
      reason: status === 403 ? 'rate_limited' : status === 404 ? 'repo_not_found' : 'fetch_failed',
    }
  }

  // Drop PRs from list mode (the issues endpoint returns both).
  const issuesOnly = rawIssues.filter((i) => !('pull_request' in i && i.pull_request))
  if (issuesOnly.length === 0) return { issues: [], relatedChunks: [] }

  // Collect refs across all issues so we lookup entities once.
  const allRefs = new Set<string>()
  const refsPerIssue = new Map<number, Set<string>>()
  for (const i of issuesOnly) {
    const text = `${i.title}\n${i.body ?? ''}`
    const refs = extractRefs(text)
    refsPerIssue.set(i.number, refs)
    for (const r of refs) allRefs.add(r)
  }
  const entityMatches = allRefs.size > 0
    ? await lookupEntitiesByRefs(db, ctx.workspaceId, [...allRefs])
    : new Map<string, LinkedEntity[]>()

  // Build per-issue relatedEntities by walking that issue's refs.
  const allRelatedEntityIds = new Set<string>()
  const finalIssues: IssueResult[] = issuesOnly.slice(0, limit).map((i) => {
    const refs = refsPerIssue.get(i.number) ?? new Set<string>()
    const linked = new Map<string, LinkedEntity>()
    for (const r of refs) {
      const hits = entityMatches.get(r.toLowerCase()) ?? []
      for (const e of hits) linked.set(e.entityId, e)
    }
    const related = [...linked.values()].slice(0, 8)
    for (const e of related) allRelatedEntityIds.add(e.entityId)
    return {
      number: i.number,
      title: i.title,
      url: i.html_url,
      labels: (i.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
        .filter(Boolean),
      bodyExcerpt: excerptIssueBody(i.body ?? ''),
      updatedAt: i.updated_at,
      relatedEntities: related,
    }
  })

  const relatedChunks = allRelatedEntityIds.size > 0
    ? await fetchChunksForEntities(db, ctx.workspaceId, [...allRelatedEntityIds])
    : []

  return { issues: finalIssues, relatedChunks }
}

// ---------- list_prs ----------
/**
 * Open / merged GitHub pull requests from the workspace repo. Same
 * Octokit-anonymous budget as list_issues. Lives outside the graph
 * (no schema for PR entities yet) — fetched on demand.
 */
export interface ListPrsParams {
  state?: 'open' | 'closed' | 'all'
  labels?: string[]
  limit?: number
  prNumber?: number
}

export interface PrResult {
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  merged: boolean
  mergedAt: string | null
  author: string | null
  bodyExcerpt: string
  labels: string[]
  /** Issue numbers the PR body references via `fixes #N` / `closes #N`. */
  referencedIssues: number[]
  updatedAt: string
}

export interface PrsEnvelope {
  prs: PrResult[]
  reason?: 'no_source_url' | 'not_github' | 'rate_limited' | 'repo_not_found' | 'fetch_failed'
}

const FIX_REF_RE = /(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d{1,7})/gi

export async function listPrs(
  params: ListPrsParams,
  ctx: OperatorContext,
  db: Database,
): Promise<PrsEnvelope> {
  const sourceUrl = ctx.workspace?.sourceUrl ?? null
  if (!sourceUrl) return { prs: [], reason: 'no_source_url' }
  const match = sourceUrl.match(KAG_GH_URL_RE)
  if (!match) return { prs: [], reason: 'not_github' }
  const owner = match[1] as string
  const repo = match[2] as string
  const limit = Math.min(Math.max(params.limit ?? 15, 1), 30)

  const octokit = new Octokit()
  try {
    if (params.prNumber) {
      const single = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: params.prNumber,
      })
      return { prs: [normalisePr(single.data)] }
    }
    const res = await octokit.rest.pulls.list({
      owner,
      repo,
      state: params.state ?? 'all',
      per_page: limit,
      sort: 'updated',
      direction: 'desc',
    })
    return { prs: res.data.map(normalisePr) }
  } catch (err) {
    const status = (err as { status?: number }).status ?? 0
    return {
      prs: [],
      reason: status === 403 ? 'rate_limited' : status === 404 ? 'repo_not_found' : 'fetch_failed',
    }
  }
}

function normalisePr(p: Record<string, unknown>): PrResult {
  const body = typeof p.body === 'string' ? p.body : ''
  const refs = new Set<number>()
  for (const m of body.matchAll(FIX_REF_RE)) {
    const n = Number(m[1])
    if (Number.isFinite(n)) refs.add(n)
  }
  const labels = Array.isArray(p.labels)
    ? p.labels.map((l: unknown) => (typeof l === 'string' ? l : (l as { name?: string }).name ?? '')).filter(Boolean)
    : []
  return {
    number: p.number as number,
    title: p.title as string,
    url: p.html_url as string,
    state: p.state as 'open' | 'closed',
    merged: Boolean(p.merged_at),
    mergedAt: (p.merged_at as string | null) ?? null,
    author: ((p.user as { login?: string } | null)?.login) ?? null,
    bodyExcerpt: excerptIssueBody(body),
    labels,
    referencedIssues: [...refs],
    updatedAt: p.updated_at as string,
  }
}

// ---------- find_prs_for_issue ----------
/**
 * Graph query: PRs whose metadata.referencedIssues contains the given
 * issue number. Returns persisted pull_request entities so the answer
 * can ground "how was this issue fixed" in concrete merged PRs.
 */
export interface FindPrsForIssueParams {
  issueNumber: number
  limit?: number
}

export interface PrSummary {
  id: string
  number: number
  title: string
  url: string | null
  mergedAt: string | null
  author: string | null
  bodyExcerpt: string | null
}

export async function findPrsForIssue(
  params: FindPrsForIssueParams,
  ctx: OperatorContext,
  db: Database,
): Promise<PrSummary[]> {
  if (!Number.isFinite(params.issueNumber) || params.issueNumber < 1) return []
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 30)
  const rows = await db.execute<{
    id: string
    metadata: Record<string, unknown> | null
  }>(sql`
    SELECT id, metadata
    FROM ${entities}
    WHERE workspace_id = ${ctx.workspaceId}
      AND type = 'pull_request'
      AND metadata -> 'referencedIssues' @> ${JSON.stringify([params.issueNumber])}::jsonb
    ORDER BY (metadata ->> 'mergedAt') DESC NULLS LAST
    LIMIT ${limit}
  `)
  return rows.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return {
      id: r.id,
      number: (meta.number as number | undefined) ?? 0,
      title: (meta.title as string | undefined) ?? '',
      url: (meta.url as string | null | undefined) ?? null,
      mergedAt: (meta.mergedAt as string | null | undefined) ?? null,
      author: (meta.author as string | null | undefined) ?? null,
      bodyExcerpt: (meta.bodyExcerpt as string | null | undefined) ?? null,
    }
  })
}

// ---------- find_similar_issues ----------
/**
 * In-memory TTL cache for issue embeddings. Keyed by workspace ID;
 * value carries the issue snapshot (list + each issue's pre-computed
 * embedding) and the timestamp it was built. TTL = 30 min — long
 * enough to amortise repeated similar-issue queries within a single
 * exploration session, short enough that closed issues / new issues
 * eventually flow in. Survives a single Node process — workers and
 * web are separate processes so each warms its own cache.
 */
interface IssueEmbeddingCacheEntry {
  builtAt: number
  issues: { number: number; title: string; body: string; url: string; state: 'open' | 'closed'; labels: string[] }[]
  vectors: number[][]
}
const ISSUE_EMBED_CACHE = new Map<string, IssueEmbeddingCacheEntry>()
const ISSUE_EMBED_TTL_MS = 30 * 60 * 1000

export interface FindSimilarIssuesParams {
  issueNumber?: number
  query?: string
  /** Max results. Default 5, max 10. */
  limit?: number
}

export interface SimilarIssueResult {
  number: number
  title: string
  url: string
  similarity: number
  state: 'open' | 'closed'
  bodyExcerpt: string
  labels: string[]
}

export async function findSimilarIssues(
  params: FindSimilarIssuesParams,
  ctx: OperatorContext,
  db: Database,
): Promise<{ similar: SimilarIssueResult[]; reason?: string }> {
  const sourceUrl = ctx.workspace?.sourceUrl ?? null
  if (!sourceUrl) return { similar: [], reason: 'no_source_url' }
  const match = sourceUrl.match(KAG_GH_URL_RE)
  if (!match) return { similar: [], reason: 'not_github' }
  const owner = match[1] as string
  const repo = match[2] as string
  const limit = Math.min(Math.max(params.limit ?? 5, 1), 10)
  const octokit = new Octokit()

  // 1. Resolve target text.
  let targetText: string
  let targetNumber: number | null = null
  if (params.issueNumber) {
    try {
      const single = await octokit.rest.issues.get({
        owner, repo, issue_number: params.issueNumber,
      })
      targetText = `${single.data.title}\n\n${single.data.body ?? ''}`
      targetNumber = params.issueNumber
    } catch {
      return { similar: [], reason: 'fetch_failed' }
    }
  } else if (params.query && params.query.trim().length > 0) {
    targetText = params.query.trim()
  } else {
    return { similar: [], reason: 'no_target' }
  }

  // 2. Resolve candidate pool + vectors. Cache by workspaceId so a
  // multi-turn exploration session ("find similar to #191" then
  // "similar to #205") re-uses the same embedded pool instead of
  // burning ~$0.003 + 30s latency per call.
  const cacheKey = ctx.workspaceId
  const cached = ISSUE_EMBED_CACHE.get(cacheKey)
  let pool: IssueEmbeddingCacheEntry['issues']
  let candidateVecs: number[][]
  if (cached && Date.now() - cached.builtAt < ISSUE_EMBED_TTL_MS) {
    pool = cached.issues.filter((i) => i.number !== targetNumber)
    candidateVecs = cached.issues
      .map((i, idx) => (i.number !== targetNumber ? cached.vectors[idx] : null))
      .filter((v): v is number[] => v != null)
  } else {
    let raw: Awaited<ReturnType<typeof octokit.rest.issues.listForRepo>>['data']
    try {
      const res = await octokit.rest.issues.listForRepo({
        owner, repo, state: 'all', per_page: 60, sort: 'updated', direction: 'desc',
      })
      raw = res.data.filter((i) => !('pull_request' in i && i.pull_request))
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0
      return { similar: [], reason: status === 403 ? 'rate_limited' : 'fetch_failed' }
    }
    if (raw.length === 0) return { similar: [] }
    const snapshot: IssueEmbeddingCacheEntry['issues'] = raw.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      url: i.html_url,
      state: i.state as 'open' | 'closed',
      labels: (i.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
        .filter(Boolean),
    }))
    const corpus = snapshot.map((i) => `${i.title}\n\n${i.body}`.slice(0, 4000))
    const vectors = await ctx.embeddings.embedBatch(corpus)
    ISSUE_EMBED_CACHE.set(cacheKey, {
      builtAt: Date.now(),
      issues: snapshot,
      vectors,
    })
    pool = targetNumber !== null
      ? snapshot.filter((i) => i.number !== targetNumber)
      : snapshot
    candidateVecs = snapshot
      .map((i, idx) => (i.number !== targetNumber ? vectors[idx] : null))
      .filter((v): v is number[] => v != null)
  }
  if (pool.length === 0) return { similar: [] }

  // 3. Embed the target ONLY (single-element batch). Cached pool
  // embeddings persist — see ISSUE_EMBED_CACHE above.
  const targetVecs = await ctx.embeddings.embedBatch([targetText.slice(0, 4000)])
  const targetVec = targetVecs[0]
  if (!targetVec) return { similar: [] }

  // 4. Cosine similarity, top-K.
  const scored = pool.map((i, idx) => {
    const v = candidateVecs[idx]
    return { issue: i, score: v ? cosine(targetVec, v) : 0 }
  })
  scored.sort((a, b) => b.score - a.score)
  return {
    similar: scored.slice(0, limit).map(({ issue, score }) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      similarity: Math.round(score * 1000) / 1000,
      state: issue.state,
      bodyExcerpt: excerptIssueBody(issue.body),
      labels: issue.labels,
    })),
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ---------- find_resolution ----------
/**
 * Detect whether an open issue is ALREADY solved (or being solved)
 * elsewhere before the agent spends tokens investigating. Returns a
 * structured envelope that classifies the resolution status into one
 * of five buckets so the UI can show different banner colours and
 * the agentic prompt can phrase the answer correctly.
 *
 * Status classification (highest-signal wins):
 *   merged          → indexed commit matches `fixes #N`
 *   open_pr         → live GitHub search finds open non-draft PR
 *   draft_pr        → draft PR exists (BEST contributor onramp)
 *   stale_pr        → PR inactive >90d
 *   duplicate_closed → cosine-similar closed issue ≥0.85
 *   related         → cosine 0.70–0.85
 *   none            → nothing fired
 */
export interface FindResolutionParams {
  issueNumber: number
}

export const FIX_REF_RE_FOR = (n: number): RegExp =>
  new RegExp(`(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\\s+#${n}\\b`, 'i')

const STALE_PR_MS = 90 * 24 * 60 * 60 * 1000

export async function findResolution(
  params: FindResolutionParams,
  ctx: OperatorContext,
  db: Database,
): Promise<ResolutionEnvelope> {
  const n = Number(params.issueNumber)
  if (!Number.isFinite(n) || n < 1) {
    return emptyResolution(n, 'no_issue')
  }
  const sourceUrl = ctx.workspace?.sourceUrl ?? null
  if (!sourceUrl) return emptyResolution(n, 'no_source_url')
  const m = sourceUrl.match(KAG_GH_URL_RE)
  if (!m) return emptyResolution(n, 'not_github')
  const owner = m[1] as string
  const repo = m[2] as string

  // Channel 1 — indexed commits with `fixes #N` in message body.
  const commitRe = `(fix(es|ed)?|close[sd]?|resolve[sd]?)[[:space:]]+#${n}([^0-9]|$)`
  const commitRows = await db.execute<{
    sha: string
    message: string
    author: string
    date: string
  }>(sql`
    SELECT
      c.metadata->>'sha'     AS sha,
      c.metadata->>'message' AS message,
      c.metadata->>'author'  AS author,
      c.metadata->>'date'    AS date
    FROM ${entities} c
    WHERE c.workspace_id = ${ctx.workspaceId}
      AND c.type = 'commit'
      AND c.metadata->>'message' ~* ${commitRe}
    ORDER BY (c.metadata->>'date')::timestamptz DESC
    LIMIT 10
  `)
  const mergedByCommits: ResolutionCommit[] = [...commitRows]

  // Channel 2 — live GitHub search for any PRs mentioning #N.
  const octokit = new Octokit()
  const refRe = FIX_REF_RE_FOR(n)
  const linkedPullRequests: ResolutionPr[] = []
  try {
    const search = await octokit.rest.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo} type:pr "#${n}"`,
      per_page: 30,
      sort: 'updated',
      order: 'desc',
    })
    for (const item of search.data.items) {
      const body = typeof item.body === 'string' ? item.body : ''
      const titleAndBody = `${item.title}\n${body}`
      if (!refRe.test(titleAndBody)) continue
      if (linkedPullRequests.length >= 5) break
      let detail: Awaited<ReturnType<typeof octokit.rest.pulls.get>>['data'] | null = null
      try {
        const got = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: item.number,
        })
        detail = got.data
      } catch {
        continue
      }
      const lastCommitAt = detail.updated_at ?? null
      const stale = computeStale(detail)
      linkedPullRequests.push({
        number: detail.number,
        title: detail.title,
        url: detail.html_url,
        state: detail.state as 'open' | 'closed',
        draft: Boolean(detail.draft),
        merged: Boolean(detail.merged_at),
        mergedAt: detail.merged_at ?? null,
        author: detail.user?.login ?? null,
        lastCommitAt,
        stale,
        bodyExcerpt: excerptIssueBody(detail.body ?? ''),
      })
    }
  } catch (err) {
    const status = (err as { status?: number }).status ?? 0
    if (status === 403) {
      return {
        ...emptyResolution(n),
        mergedByCommits,
        reason: 'rate_limited',
      }
    }
  }

  // Channel 3 — cosine-similar issues. Delegate to findSimilarIssues
  // (cached per workspace) so we don't burn an extra embedding pass.
  const sim = await findSimilarIssues({ issueNumber: n, limit: 8 }, ctx, db)
  const duplicateCandidates: ResolutionDuplicate[] = sim.similar
    .filter((s) => s.similarity >= 0.7 && s.number !== n)
    .map((s) => ({
      number: s.number,
      title: s.title,
      url: s.url,
      state: s.state,
      similarity: s.similarity,
    }))

  return classifyResolution(n, mergedByCommits, linkedPullRequests, duplicateCandidates)
}

export function classifyResolution(
  issueNumber: number,
  mergedByCommits: ResolutionCommit[],
  linkedPullRequests: ResolutionPr[],
  duplicateCandidates: ResolutionDuplicate[],
): ResolutionEnvelope {
  if (mergedByCommits.length > 0) {
    return {
      issueNumber,
      status: 'merged',
      confidence: 'high',
      mergedByCommits,
      linkedPullRequests,
      duplicateCandidates,
    }
  }
  const openReady = linkedPullRequests.find((p) => p.state === 'open' && !p.draft && !p.stale && !p.merged)
  if (openReady) {
    return {
      issueNumber,
      status: 'open_pr',
      confidence: 'medium',
      mergedByCommits,
      linkedPullRequests,
      duplicateCandidates,
    }
  }
  const draft = linkedPullRequests.find((p) => p.state === 'open' && p.draft && !p.merged)
  if (draft) {
    return {
      issueNumber,
      status: 'draft_pr',
      confidence: 'medium',
      mergedByCommits,
      linkedPullRequests,
      duplicateCandidates,
    }
  }
  const stale = linkedPullRequests.find((p) => p.state === 'open' && p.stale && !p.merged)
  if (stale) {
    return {
      issueNumber,
      status: 'stale_pr',
      confidence: 'low',
      mergedByCommits,
      linkedPullRequests,
      duplicateCandidates,
    }
  }
  const dupeClosed = duplicateCandidates.find((d) => d.state === 'closed' && d.similarity >= 0.85)
  if (dupeClosed) {
    return {
      issueNumber,
      status: 'duplicate_closed',
      confidence: 'medium',
      mergedByCommits,
      linkedPullRequests,
      duplicateCandidates,
    }
  }
  if (duplicateCandidates.length > 0) {
    return {
      issueNumber,
      status: 'related',
      confidence: 'low',
      mergedByCommits,
      linkedPullRequests,
      duplicateCandidates,
    }
  }
  return {
    issueNumber,
    status: 'none',
    confidence: 'low',
    mergedByCommits,
    linkedPullRequests,
    duplicateCandidates,
  }
}

function computeStale(
  pr: Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'],
): boolean {
  if (pr.state !== 'open' || pr.merged_at) return false
  const updated = pr.updated_at ? Date.parse(pr.updated_at) : 0
  if (!updated) return false
  return Date.now() - updated > STALE_PR_MS
}

function emptyResolution(
  issueNumber: number,
  reason?: ResolutionEnvelope['reason'],
): ResolutionEnvelope {
  return {
    issueNumber,
    status: 'none',
    confidence: 'low',
    mergedByCommits: [],
    linkedPullRequests: [],
    duplicateCandidates: [],
    ...(reason ? { reason } : {}),
  }
}

// ---------- @Injectable wrappers ----------

@Injectable()
export class ListIssuesOperator implements KagOperator<ListIssuesParams, IssuesEnvelope> {
  readonly name = 'list_issues' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: ListIssuesParams, c: OperatorContext) { return listIssues(p, c, this.db) }
}

@Injectable()
export class ListPrsOperator implements KagOperator<ListPrsParams, PrsEnvelope> {
  readonly name = 'list_prs' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: ListPrsParams, c: OperatorContext) { return listPrs(p, c, this.db) }
}

@Injectable()
export class FindPrsForIssueOperator implements KagOperator<FindPrsForIssueParams, PrSummary[]> {
  readonly name = 'find_prs_for_issue' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: FindPrsForIssueParams, c: OperatorContext) { return findPrsForIssue(p, c, this.db) }
}

@Injectable()
export class FindSimilarIssuesOperator implements KagOperator<FindSimilarIssuesParams> {
  readonly name = 'find_similar_issues' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: FindSimilarIssuesParams, c: OperatorContext) { return findSimilarIssues(p, c, this.db) }
}

@Injectable()
export class FindResolutionOperator implements KagOperator<FindResolutionParams, ResolutionEnvelope> {
  readonly name = 'find_resolution' as const
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  execute(p: FindResolutionParams, c: OperatorContext) { return findResolution(p, c, this.db) }
}
