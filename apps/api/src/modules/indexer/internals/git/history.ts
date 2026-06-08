import { simpleGit, type SimpleGit } from 'simple-git'

export interface CommitDiffPerFile {
  filePath: string
  diff: string
}

export interface GitCommit {
  sha: string
  authorName: string
  authorEmail: string
  date: Date
  message: string
  filesChanged: string[]
  /** Concatenated unified diff for the commit, truncated to DIFF_TOTAL_CAP. */
  diff: string | null
  /** Per-file diffs (already truncated to DIFF_PER_FILE_CAP each). */
  diffsByFile: CommitDiffPerFile[]
  /** True if the diff was clipped due to size caps. */
  diffTruncated: boolean
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
const DIFF_TOTAL_CAP = 60_000 // chars per whole commit
const DIFF_PER_FILE_CAP = 30_000 // chars per file diff

export interface ExtractGitHistoryOptions {
  maxCommits?: number
  hotWindowDays?: number
  /** Set false in tests to skip the per-commit `git show` call. */
  includeDiffs?: boolean
}

export async function extractGitHistory(
  workdir: string,
  options: ExtractGitHistoryOptions = {},
): Promise<GitHistory> {
  const git = simpleGit({ baseDir: workdir })
  const maxCommits = options.maxCommits ?? MAX_COMMITS
  const hotWindowDays = options.hotWindowDays ?? HOT_WINDOW_DAYS
  const includeDiffs = options.includeDiffs ?? true

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

  return readHistory(git, maxCommits, hotWindowDays, includeDiffs)
}

async function readHistory(
  git: SimpleGit,
  maxCommits: number,
  hotWindowDays: number,
  includeDiffs: boolean,
): Promise<GitHistory> {
  const log = await git.log({
    maxCount: maxCommits,
    '--no-merges': null,
  })

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

    let diff: string | null = null
    let diffsByFile: CommitDiffPerFile[] = []
    let diffTruncated = false
    if (includeDiffs && filesChanged.length > 0) {
      try {
        // --format=  drops the commit header from `git show` output, leaving
        // just the unified diff. `-U2` keeps context lines bounded (2 lines)
        // so big diffs don't balloon needlessly.
        const raw = await git.raw([
          'show',
          '--format=',
          '-U2',
          entry.hash,
        ])
        const parsed = splitDiffByFile(raw)
        for (const file of parsed) {
          if (file.diff.length > DIFF_PER_FILE_CAP) {
            file.diff = file.diff.slice(0, DIFF_PER_FILE_CAP) + '\n[...truncated]'
            diffTruncated = true
          }
        }
        diffsByFile = parsed
        // Combined diff (capped) for metadata.
        let combined = ''
        for (const file of parsed) {
          if (combined.length + file.diff.length + 80 > DIFF_TOTAL_CAP) {
            const remaining = parsed.length - parsed.indexOf(file)
            combined += `\n[...${remaining} more file(s) elided due to size]`
            diffTruncated = true
            break
          }
          combined += `\n--- ${file.filePath} ---\n${file.diff}`
        }
        diff = combined.length > 0 ? combined.trim() : null
      } catch {
        /* skip diff if anything goes wrong */
      }
    }

    commits.push({
      sha: entry.hash,
      authorName: entry.author_name || 'unknown',
      authorEmail: entry.author_email || '',
      date: entry.date ? new Date(entry.date) : new Date(0),
      message: entry.message,
      filesChanged,
      diff,
      diffsByFile,
      diffTruncated,
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

/**
 * Split a `git show --format= -U2 <sha>` payload into per-file diffs.
 * Each `diff --git a/<path> b/<path>` line starts a new file block;
 * everything until the next `diff --git` belongs to the previous one.
 */
function splitDiffByFile(raw: string): CommitDiffPerFile[] {
  const lines = raw.split('\n')
  const out: CommitDiffPerFile[] = []
  let currentPath: string | null = null
  let currentBody: string[] = []

  const flush = (): void => {
    if (currentPath !== null && currentBody.length > 0) {
      out.push({ filePath: currentPath, diff: currentBody.join('\n') })
    }
  }

  for (const line of lines) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (m) {
      flush()
      // Prefer the b/ path (post-change name).
      currentPath = m[2] ?? m[1] ?? null
      currentBody = [line]
    } else if (currentPath !== null) {
      currentBody.push(line)
    }
  }
  flush()
  return out
}
