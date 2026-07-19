/**
 * Indexer step: pull recent merged GitHub pull requests for the
 * workspace's source repo and persist them as `pull_request` entities.
 *
 * Why persist (vs live GitHub queries): once issues are linked to
 * fixing PRs via metadata.referencedIssues, the chat can answer
 * "how was a similar issue fixed before" by graph query — no GitHub
 * round-trip per question. Survives rate-limit windows.
 *
 * Scope: up to 200 most recently updated merged PRs — that's 2
 * paginated calls (per_page=100) via createOctokit() (60 req/h
 * anonymous, 5000 req/h with GITHUB_TOKEN). No diff fetching (would
 * be 200 extra calls) — body excerpt only.
 */
import type { Database } from '#server/db/client'
import { entities } from '#server/db/schema'
import { createOctokit } from '#server/lib/github'
import { getLogger } from '#server/lib/logger'

const log = getLogger().child({ component: 'indexer/pr-history' })

const GH_URL_RE = /github\.com\/([^/]+)\/([^/.]+)/
const FIX_REF_RE = /(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d{1,7})/gi

export async function indexPullRequests(
  db: Database,
  workspaceId: string,
  sourceUrl: string | null,
): Promise<{ inserted: number; skipped: number; reason?: string }> {
  if (!sourceUrl) return { inserted: 0, skipped: 0, reason: 'no_source_url' }
  const m = sourceUrl.match(GH_URL_RE)
  if (!m) return { inserted: 0, skipped: 0, reason: 'not_github' }
  const owner = m[1] as string
  const repo = m[2] as string

  // We rely on the unique (workspace_id, qualified_name) constraint
  // for idempotence — pr::N stays stable across re-indexings, ON
  // CONFLICT DO NOTHING below makes the upsert safe. To pick up
  // changed PR metadata we'd need DO UPDATE — deferred.

  const octokit = createOctokit()
  const all: Awaited<ReturnType<typeof octokit.rest.pulls.list>>['data'] = []
  for (const page of [1, 2]) {
    try {
      const res = await octokit.rest.pulls.list({
        owner,
        repo,
        state: 'closed',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
        page,
      })
      all.push(...res.data)
      if (res.data.length < 100) break
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0
      log.warn({ owner, repo, status }, 'PR list fetch failed; persisting what we have')
      break
    }
  }
  // We only care about MERGED PRs — closed-without-merge is noise for
  // "how was a similar issue fixed".
  const merged = all.filter((p) => Boolean(p.merged_at))
  if (merged.length === 0) return { inserted: 0, skipped: 0, reason: 'no_merged_prs' }

  const rows = merged.map((p) => {
    const body = typeof p.body === 'string' ? p.body : ''
    const refs = new Set<number>()
    for (const m of body.matchAll(FIX_REF_RE)) {
      const n = Number(m[1])
      if (Number.isFinite(n)) refs.add(n)
    }
    return {
      workspaceId,
      type: 'pull_request' as const,
      name: `#${p.number}: ${p.title}`.slice(0, 200),
      qualifiedName: `pr::${p.number}`,
      normalizedName: String(p.number),
      metadata: {
        number: p.number,
        title: p.title,
        url: p.html_url,
        state: p.state,
        mergedAt: p.merged_at,
        author: p.user?.login ?? null,
        bodyExcerpt: excerptPrBody(body),
        labels: (p.labels ?? [])
          .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
          .filter(Boolean),
        referencedIssues: [...refs],
        updatedAt: p.updated_at,
      },
    }
  })

  // ON CONFLICT DO NOTHING uses the workspace+qualifiedName unique
  // constraint so re-runs are idempotent. To pick up changed PR
  // metadata across re-indexings we'd need DO UPDATE — deferred.
  const inserted = await db
    .insert(entities)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: entities.id })

  return {
    inserted: inserted.length,
    skipped: rows.length - inserted.length,
  }
}

function excerptPrBody(body: string): string {
  const cleaned = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/[#*_`>]/g, '')
    .trim()
  return cleaned.length > 400 ? cleaned.slice(0, 397) + '…' : cleaned
}
