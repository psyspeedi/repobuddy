import type { GitHistory, GitCommit } from './history'

export interface GitInsights {
  lastCommitAt: string | null
  totalCommitsScanned: number
  commitsLast30d: number
  commitsLast90d: number
  activeMaintainers90d: number
  topAuthors: { name: string; email: string; commitCount: number }[]
  busFactor: number
  fixCount: number
  featCount: number
  fixVsFeatRatio: number | null
  breakingChangesLast90d: number
  commitFrequencyByMonth: { month: string; commits: number }[]
  windowDays: number
}

const RECENCY_WINDOW_DAYS = 90
const SHORT_RECENCY_DAYS = 30
const CONVENTIONAL_RE = /^(\w+)(\([^)]*\))?(!)?\s*:/

export function computeGitInsights(history: GitHistory): GitInsights {
  const commits = history.commits
  if (commits.length === 0) {
    return {
      lastCommitAt: null,
      totalCommitsScanned: 0,
      commitsLast30d: 0,
      commitsLast90d: 0,
      activeMaintainers90d: 0,
      topAuthors: [],
      busFactor: 0,
      fixCount: 0,
      featCount: 0,
      fixVsFeatRatio: null,
      breakingChangesLast90d: 0,
      commitFrequencyByMonth: [],
      windowDays: RECENCY_WINDOW_DAYS,
    }
  }

  const now = Date.now()
  const cutoff90 = now - RECENCY_WINDOW_DAYS * 86400 * 1000
  const cutoff30 = now - SHORT_RECENCY_DAYS * 86400 * 1000

  let commitsLast30d = 0
  let commitsLast90d = 0
  let fixCount = 0
  let featCount = 0
  let breakingChangesLast90d = 0
  const activeAuthorKeys90d = new Set<string>()
  const monthBuckets = new Map<string, number>()
  let mostRecent = 0

  for (const c of commits) {
    const t = c.date.getTime()
    if (t > mostRecent) mostRecent = t
    if (t >= cutoff30) commitsLast30d++
    if (t >= cutoff90) {
      commitsLast90d++
      activeAuthorKeys90d.add(authorKey(c))
      if (isBreaking(c)) breakingChangesLast90d++
    }
    const type = conventionalType(c.message)
    if (type === 'fix') fixCount++
    if (type === 'feat') featCount++

    const month = formatMonth(c.date)
    monthBuckets.set(month, (monthBuckets.get(month) ?? 0) + 1)
  }

  const sortedAuthors = [...history.authors].sort(
    (a, b) => b.commitCount - a.commitCount,
  )
  const topAuthors = sortedAuthors.slice(0, 5).map((a) => ({
    name: a.name,
    email: a.email,
    commitCount: a.commitCount,
  }))

  const busFactor = computeBusFactor(sortedAuthors, commits.length)

  const commitFrequencyByMonth = [...monthBuckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, c]) => ({ month, commits: c }))

  return {
    lastCommitAt: mostRecent > 0 ? new Date(mostRecent).toISOString() : null,
    totalCommitsScanned: commits.length,
    commitsLast30d,
    commitsLast90d,
    activeMaintainers90d: activeAuthorKeys90d.size,
    topAuthors,
    busFactor,
    fixCount,
    featCount,
    fixVsFeatRatio: featCount > 0 ? Number((fixCount / featCount).toFixed(2)) : null,
    breakingChangesLast90d,
    commitFrequencyByMonth,
    windowDays: RECENCY_WINDOW_DAYS,
  }
}

function authorKey(c: GitCommit): string {
  return `${c.authorName}::${c.authorEmail}`.toLowerCase()
}

function conventionalType(message: string): string | null {
  const firstLine = message.split('\n')[0] ?? ''
  const m = CONVENTIONAL_RE.exec(firstLine.trim())
  return m?.[1]?.toLowerCase() ?? null
}

function isBreaking(c: GitCommit): boolean {
  const firstLine = c.message.split('\n')[0] ?? ''
  const m = CONVENTIONAL_RE.exec(firstLine.trim())
  if (m?.[3] === '!') return true
  return /^BREAKING[- ]CHANGE:/m.test(c.message)
}

function formatMonth(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0')
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  return `${y}-${m}`
}

function computeBusFactor(
  authors: { commitCount: number }[],
  total: number,
): number {
  if (total === 0 || authors.length === 0) return 0
  const half = total / 2
  let running = 0
  for (let i = 0; i < authors.length; i++) {
    running += authors[i]?.commitCount ?? 0
    if (running >= half) return i + 1
  }
  return authors.length
}
