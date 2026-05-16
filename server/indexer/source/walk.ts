import { readdir, readFile, stat } from 'node:fs/promises'
import { relative, join } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { detectLanguageFromPath, summariseLanguages } from './languages'
import type { Language } from '#shared/types'

const HARD_EXCLUDES = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  '.cache',
  '.idea',
  '.vscode',
  'coverage',
  '.turbo',
])

const HARD_SUFFIX_EXCLUDES = [
  '.min.js',
  '.min.css',
  '.map',
  '.lock',
  '.bin',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
]

const MAX_FILE_BYTES = 1024 * 1024 // 1 MB

export interface DiscoveredFile {
  /** Absolute path on disk. */
  absPath: string
  /** Workspace-relative path (always POSIX-style). */
  relPath: string
  language: Language | null
  sizeBytes: number
}

export interface WalkResult {
  files: DiscoveredFile[]
  languages: Language[]
}

/**
 * Walk a working tree, applying hard excludes + any nested .gitignore patterns,
 * and return all source files (≤1 MB) with their detected language.
 */
export async function walkRepo(
  workdir: string,
  options: { maxFiles?: number } = {},
): Promise<WalkResult> {
  const maxFiles = options.maxFiles ?? 2000
  const files: DiscoveredFile[] = []
  const rootIgnore = await loadIgnore(workdir)

  await walk(workdir, workdir, rootIgnore, files, maxFiles)

  const languages = summariseLanguages(files.map((f) => f.language))
  return { files, languages }
}

async function loadIgnore(dir: string): Promise<Ignore> {
  const ig = ignore()
  try {
    const content = await readFile(join(dir, '.gitignore'), 'utf-8')
    ig.add(content)
  } catch {
    /* no .gitignore — fine */
  }
  return ig
}

async function walk(
  root: string,
  dir: string,
  parentIgnore: Ignore,
  acc: DiscoveredFile[],
  maxFiles: number,
): Promise<void> {
  if (acc.length >= maxFiles) return

  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  // Local ignore inherits parent and appends this dir's .gitignore if present.
  const localIgnore = ignore().add(parentIgnore as never)
  try {
    const content = await readFile(join(dir, '.gitignore'), 'utf-8')
    localIgnore.add(content)
  } catch {
    /* no nested .gitignore */
  }

  for (const entry of entries) {
    if (acc.length >= maxFiles) return
    if (HARD_EXCLUDES.has(entry.name)) continue

    const absPath = join(dir, entry.name)
    const relPath = relative(root, absPath).split(/[\\/]/).join('/')

    if (localIgnore.ignores(relPath)) continue

    if (entry.isDirectory()) {
      await walk(root, absPath, localIgnore, acc, maxFiles)
      continue
    }

    if (!entry.isFile()) continue
    if (HARD_SUFFIX_EXCLUDES.some((s) => entry.name.toLowerCase().endsWith(s))) continue

    let size: number
    try {
      const st = await stat(absPath)
      size = st.size
    } catch {
      continue
    }
    if (size > MAX_FILE_BYTES) continue

    acc.push({
      absPath,
      relPath,
      language: detectLanguageFromPath(entry.name),
      sizeBytes: size,
    })
  }
}
