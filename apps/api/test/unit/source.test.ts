import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  detectLanguageFromPath,
  detectLanguagesFromManifest,
  summariseLanguages,
} from '#server/indexer/source/languages'
import { walkRepo } from '#server/indexer/source/walk'

const TS_FIXTURE = resolve(__dirname, '../fixtures/repos/ts-sample')
const PY_FIXTURE = resolve(__dirname, '../fixtures/repos/py-sample')
const GO_FIXTURE = resolve(__dirname, '../fixtures/repos/go-sample')

describe('detectLanguageFromPath', () => {
  it('classifies TypeScript', () => {
    expect(detectLanguageFromPath('src/orders.ts')).toBe('typescript')
    expect(detectLanguageFromPath('App.tsx')).toBe('typescript')
    expect(detectLanguageFromPath('config.mts')).toBe('typescript')
  })
  it('classifies JavaScript', () => {
    expect(detectLanguageFromPath('index.js')).toBe('javascript')
    expect(detectLanguageFromPath('script.cjs')).toBe('javascript')
  })
  it('classifies Python and Go', () => {
    expect(detectLanguageFromPath('main.py')).toBe('python')
    expect(detectLanguageFromPath('stub.pyi')).toBe('python')
    expect(detectLanguageFromPath('orders.go')).toBe('go')
  })
  it('returns null for unknown extensions', () => {
    expect(detectLanguageFromPath('README.md')).toBeNull()
    expect(detectLanguageFromPath('image.png')).toBeNull()
  })
})

describe('detectLanguagesFromManifest', () => {
  it('maps manifests to languages', () => {
    expect(detectLanguagesFromManifest('package.json')).toContain('typescript')
    expect(detectLanguagesFromManifest('pyproject.toml')).toEqual(['python'])
    expect(detectLanguagesFromManifest('go.mod')).toEqual(['go'])
    expect(detectLanguagesFromManifest('Cargo.toml')).toEqual([])
  })
})

describe('summariseLanguages', () => {
  it('orders by frequency descending', () => {
    expect(
      summariseLanguages(['typescript', 'python', 'typescript', null, 'go', 'typescript']),
    ).toEqual(['typescript', 'python', 'go'])
  })
})

describe('walkRepo (fixtures)', () => {
  it('walks ts-sample and detects typescript', async () => {
    const result = await walkRepo(TS_FIXTURE)
    expect(result.languages).toContain('typescript')
    const ts = result.files.filter((f) => f.language === 'typescript')
    expect(ts.map((f) => f.relPath).sort()).toEqual([
      'src/index.ts',
      'src/orders.ts',
      'src/telemetry.ts',
    ])
  })

  it('walks py-sample and detects python', async () => {
    const result = await walkRepo(PY_FIXTURE)
    expect(result.languages).toContain('python')
    const py = result.files.filter((f) => f.language === 'python').map((f) => f.relPath)
    expect(py.sort()).toEqual(['main.py', 'orders.py', 'telemetry.py'])
  })

  it('walks go-sample and detects go', async () => {
    const result = await walkRepo(GO_FIXTURE)
    expect(result.languages).toContain('go')
    const goFiles = result.files.filter((f) => f.language === 'go').map((f) => f.relPath)
    expect(goFiles.sort()).toEqual(['orders.go', 'telemetry.go'])
  })

  it('respects maxFiles cap', async () => {
    const result = await walkRepo(TS_FIXTURE, { maxFiles: 2 })
    expect(result.files.length).toBeLessThanOrEqual(2)
  })
})
