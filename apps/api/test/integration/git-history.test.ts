import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { simpleGit } from 'simple-git'
import { extractGitHistory } from '#server/indexer/git/history'

let workdir: string

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'repobuddy-test-git-'))
  const git = simpleGit({ baseDir: workdir })
  await git.init()
  await git.addConfig('user.email', 'test@example.com')
  await git.addConfig('user.name', 'Tester')

  await mkdir(join(workdir, 'src'), { recursive: true })
  await writeFile(join(workdir, 'src/a.ts'), 'export const a = 1\n')
  await git.add('src/a.ts')
  await git.commit('feat: add a')

  await writeFile(join(workdir, 'src/a.ts'), 'export const a = 2\n')
  await writeFile(join(workdir, 'src/b.ts'), 'export const b = 1\n')
  await git.add(['src/a.ts', 'src/b.ts'])
  await git.commit('feat: tweak a and add b')

  await writeFile(join(workdir, 'src/a.ts'), 'export const a = 3\n')
  await git.add('src/a.ts')
  await git.commit('chore: bump a again')
})

afterAll(async () => {
  if (workdir) await rm(workdir, { recursive: true, force: true })
})

describe('extractGitHistory', () => {
  it('reads commits with authors, dates, and files', async () => {
    const hist = await extractGitHistory(workdir)
    expect(hist.commits.length).toBe(3)
    const messages = hist.commits.map((c) => c.message).sort()
    expect(messages).toEqual([
      'chore: bump a again',
      'feat: add a',
      'feat: tweak a and add b',
    ])
    expect(hist.commits[0]?.authorEmail).toBe('test@example.com')
    expect(hist.commits[0]?.date).toBeInstanceOf(Date)
  })

  it('aggregates authors and orders by commit count', async () => {
    const hist = await extractGitHistory(workdir)
    expect(hist.authors).toHaveLength(1)
    expect(hist.authors[0]?.name).toBe('Tester')
    expect(hist.authors[0]?.commitCount).toBe(3)
  })

  it('computes hotness within window', async () => {
    const hist = await extractGitHistory(workdir)
    // src/a.ts touched in all 3 commits, src/b.ts in 1
    expect(hist.hotness.get('src/a.ts')).toBe(3)
    expect(hist.hotness.get('src/b.ts')).toBe(1)
  })

  it('returns empty result for non-repo directory', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'repobuddy-test-notgit-'))
    try {
      const hist = await extractGitHistory(tmp)
      expect(hist.commits).toEqual([])
      expect(hist.authors).toEqual([])
      expect(hist.hotness.size).toBe(0)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
