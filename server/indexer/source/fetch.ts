import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { simpleGit } from 'simple-git'
import { Extract } from 'unzipper'
import { getLogger } from '../../lib/logger'

const log = getLogger().child({ component: 'indexer/source/fetch' })

const CLONE_DEPTH = 200

export interface FetchedSource {
  /** Absolute path to the working tree on disk. Caller owns cleanup via `cleanup()`. */
  workdir: string
  /** HEAD commit SHA at the time of fetch. */
  headSha: string | null
  /** Default branch (only known for git sources). */
  defaultBranch: string | null
  /** Async cleanup — safe to call multiple times. */
  cleanup: () => Promise<void>
}

export async function fetchGitHub(url: string): Promise<FetchedSource> {
  const workdir = await mkdtemp(join(tmpdir(), 'repobuddy-clone-'))
  log.info({ url, workdir }, 'cloning github repo')

  const git = simpleGit({ baseDir: workdir })
  await git.clone(url, workdir, ['--depth', String(CLONE_DEPTH), '--single-branch'])

  let headSha: string | null = null
  let defaultBranch: string | null = null
  try {
    headSha = (await git.revparse(['HEAD'])).trim()
    defaultBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
  } catch (err) {
    log.warn({ err }, 'could not determine HEAD/branch')
  }

  return {
    workdir,
    headSha,
    defaultBranch,
    cleanup: () => safeRm(workdir),
  }
}

export async function extractZip(
  zipPath: string,
): Promise<FetchedSource> {
  const workdir = await mkdtemp(join(tmpdir(), 'repobuddy-zip-'))
  await mkdir(workdir, { recursive: true })

  await new Promise<void>((resolve, reject) => {
    createReadStream(zipPath)
      .pipe(Extract({ path: workdir }))
      .on('close', resolve)
      .on('error', reject)
  })

  log.info({ zipPath, workdir }, 'extracted zip')
  return {
    workdir,
    headSha: null,
    defaultBranch: null,
    cleanup: () => safeRm(workdir),
  }
}

async function safeRm(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch (err) {
    log.warn({ path, err }, 'cleanup failed')
  }
}
