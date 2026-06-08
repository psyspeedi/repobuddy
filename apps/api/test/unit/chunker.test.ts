import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chunkCode, chunkMarkdown } from '#server/indexer/chunking/chunker'
import { getTypeScriptParser } from '#server/indexer/parsers/typescript'

const FIXTURE_DIR = resolve(__dirname, '../fixtures/repos/ts-sample')

async function chunkFile(relPath: string) {
  const absPath = resolve(FIXTURE_DIR, relPath)
  const source = await readFile(absPath, 'utf-8')
  const parseResult = await getTypeScriptParser().parse({
    relPath,
    absPath,
    source,
    language: 'typescript',
  })
  return chunkCode(relPath, source, parseResult, 'typescript')
}

describe('chunkCode', () => {
  it('emits whole-file chunk for small file', async () => {
    const chunks = await chunkFile('src/telemetry.ts')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.startLine).toBe(1)
    expect(chunks[0]?.text).toContain('TelemetryEvent')
  })

  it('emits entity-aligned chunks for class-heavy file', async () => {
    // orders.ts is small (<150 lines) so falls back to one whole-file chunk
    // by current strategy. Synthesise a larger file by repeating the source.
    const source = await readFile(resolve(FIXTURE_DIR, 'src/orders.ts'), 'utf-8')
    const padded = `// padding\n`.repeat(160) + source
    const parseResult = await getTypeScriptParser().parse({
      relPath: 'src/big.ts',
      absPath: '/dev/null',
      source: padded,
      language: 'typescript',
    })
    const chunks = chunkCode('src/big.ts', padded, parseResult, 'typescript')
    expect(chunks.length).toBeGreaterThan(1)
    const names = chunks.map((c) => c.metadata.qualifiedName).filter(Boolean)
    expect(names).toContain('src/big.ts::OrderRepository')
    expect(names).toContain('src/big.ts::OrderService')
  })

  it('does not double-emit methods as separate chunks at top level', async () => {
    const source = await readFile(resolve(FIXTURE_DIR, 'src/orders.ts'), 'utf-8')
    const padded = `// pad\n`.repeat(160) + source
    const parseResult = await getTypeScriptParser().parse({
      relPath: 'src/big.ts',
      absPath: '/dev/null',
      source: padded,
      language: 'typescript',
    })
    const chunks = chunkCode('src/big.ts', padded, parseResult, 'typescript')
    const names = chunks.map((c) => c.metadata.qualifiedName)
    expect(names.some((n) => n?.endsWith('::save'))).toBe(false)
    expect(names.some((n) => n?.endsWith('::processPayment'))).toBe(false)
  })

  it('marks each code chunk with language metadata', async () => {
    const chunks = await chunkFile('src/orders.ts')
    for (const chunk of chunks) {
      expect(chunk.metadata.language).toBe('typescript')
      expect(chunk.sourceType).toBe('code')
    }
  })
})

describe('chunkMarkdown', () => {
  it('splits at level 1-3 headings', () => {
    const md = [
      '# Title',
      'intro',
      '',
      '## Section A',
      'paragraph a',
      '',
      '### Sub',
      'paragraph b',
      '',
      '#### deeper not a split point',
      'still in sub',
    ].join('\n')

    const chunks = chunkMarkdown('README.md', md)
    expect(chunks.length).toBe(3)
    expect(chunks[0]?.text.startsWith('# Title')).toBe(true)
    expect(chunks[1]?.text.startsWith('## Section A')).toBe(true)
    expect(chunks[2]?.text.startsWith('### Sub')).toBe(true)
    expect(chunks[2]?.text).toContain('deeper not a split point')
  })

  it('returns empty array for empty input', () => {
    expect(chunkMarkdown('empty.md', '')).toEqual([])
  })
})
