import { simpleGit, type SimpleGit } from 'simple-git'

export interface GitCommit {
  sha: string
  authorName: string
  authorEmail: string
  date: Date
  message: string
  filesChanged: string[]
}

export interface GitAuthor {
  name: string
  email: string
  commitCount: number
}

export interface GitHistory {
  commits: GitCommit[]
  authors: GitAuthor[]
  /** Map of file relPath → modification count in the window. */
  hotness: Map<string, number>
  /** Hot window in days (default 90). */
  hotWindowDays: number
}

const HOT_WINDOW_DAYS = 90
const MAX_COMMITS = 200

export async function extractGitHistory(
  workdir: string,
  options: { maxCommits?: number; hotWindowDays?: number } = {},
): Promise<GitHistory> {
  const git = simpleGit({ baseDir: workdir })
  const maxCommits = options.maxCommits ?? MAX_COMMITS
  const hotWindowDays = options.hotWindowDays ?? HOT_WINDOW_DAYS

  // Check that this is actually a git repo (zip-uploaded sources won't be).
  let isRepo = false
  try {
    isRepo = await git.checkIsRepo()
  } catch {
    /* ignore */
  }
  if (!isRepo) {
    return {
      commits: [],
      authors: [],
      hotness: new Map(),
      hotWindowDays,
    }
  }

  return readHistory(git, maxCommits, hotWindowDays)
}

async function readHistory(
  git: SimpleGit,
  maxCommits: number,
  hotWindowDays: number,
): Promise<GitHistory> {
  // Pull commit metadata via simple-git's typed log API.
  const log = await git.log({
    maxCount: maxCommits,
    '--no-merges': null,
  })

  // Then attach changed files via a separate `show --name-only --no-patch`
  // call per commit. This is O(N) calls but for ≤200 commits negligible
  // and avoids brittle parsing of mixed-format git log output.
  const commits: GitCommit[] = []
  for (const entry of log.all) {
    let filesChanged: string[] = []
    try {
      const filesRaw = await git.raw([
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        '--root',
        entry.hash,
      ])
      filesChanged = filesRaw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    } catch {
      /* ignore unreadable commit */
    }
    commits.push({
      sha: entry.hash,
      authorName: entry.author_name || 'unknown',
      authorEmail: entry.author_email || '',
      date: entry.date ? new Date(entry.date) : new Date(0),
      message: entry.message,
      filesChanged,
    })
  }

  const authorMap = new Map<string, GitAuthor>()
  for (const c of commits) {
    const key = `${c.authorName}::${c.authorEmail}`.toLowerCase()
    const existing = authorMap.get(key)
    if (existing) existing.commitCount++
    else
      authorMap.set(key, {
        name: c.authorName,
        email: c.authorEmail,
        commitCount: 1,
      })
  }

  const hotness = new Map<string, number>()
  const cutoff = Date.now() - hotWindowDays * 24 * 3600 * 1000
  for (const c of commits) {
    if (c.date.getTime() < cutoff) continue
    for (const file of c.filesChanged) {
      hotness.set(file, (hotness.get(file) ?? 0) + 1)
    }
  }

  return {
    commits,
    authors: [...authorMap.values()].sort(
      (a, b) => b.commitCount - a.commitCount,
    ),
    hotness,
    hotWindowDays,
  }
}
