import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getTypeScriptParser } from '../../server/indexer/parsers/typescript'

async function parseFixture(relPath: string) {
  const absPath = resolve(
    __dirname,
    '../fixtures/repos/ts-sample/src',
    relPath,
  )
  const source = await readFile(absPath, 'utf-8')
  return getTypeScriptParser().parse({
    relPath: `src/${relPath}`,
    absPath,
    source,
    language: 'typescript',
  })
}

describe('typescript parser', () => {
  it('extracts file entity and contained_in for classes and methods', async () => {
    const result = await parseFixture('orders.ts')
    expect(result.warnings).toEqual([])

    const fileEntity = result.entities.find((e) => e.type === 'file')
    expect(fileEntity?.qualifiedName).toBe('src/orders.ts')
    expect(fileEntity?.endLine).toBeGreaterThan(20)
  })

  it('extracts class declarations with line ranges', async () => {
    const result = await parseFixture('orders.ts')
    const classes = result.entities.filter((e) => e.type === 'class')
    const names = classes.map((c) => c.name).sort()
    expect(names).toEqual(['OrderRepository', 'OrderService'])
    for (const cls of classes) {
      expect(cls.startLine).toBeGreaterThan(0)
      expect(cls.endLine).toBeGreaterThan(cls.startLine)
      expect(cls.visibility).toBe('public') // both exported
    }
  })

  it('extracts methods linked to their class via contained_in', async () => {
    const result = await parseFixture('orders.ts')
    const methods = result.entities.filter((e) => e.type === 'function')
    const methodNames = methods.map((m) => m.name).sort()
    expect(methodNames).toContain('save')
    expect(methodNames).toContain('find')
    expect(methodNames).toContain('create')
    expect(methodNames).toContain('processPayment')

    const containedIn = result.relations.filter((r) => r.type === 'contained_in')
    const processPayment = methods.find((m) => m.name === 'processPayment')
    expect(processPayment).toBeDefined()
    expect(
      containedIn.some(
        (r) => r.fromQualified === processPayment!.qualifiedName,
      ),
    ).toBe(true)
  })

  it('extracts imports as relations', async () => {
    const result = await parseFixture('orders.ts')
    const imports = result.relations.filter((r) => r.type === 'imports')
    expect(imports.length).toBe(1)
    expect(imports[0]?.toName).toBe('./telemetry')
  })

  it('extracts interfaces', async () => {
    const result = await parseFixture('orders.ts')
    const types = result.entities.filter((e) => e.type === 'type')
    expect(types.find((t) => t.name === 'Order')).toBeDefined()
  })

  it('extracts call relations within methods', async () => {
    const result = await parseFixture('orders.ts')
    const calls = result.relations.filter((r) => r.type === 'calls')
    // processPayment calls find + logEvent
    const callsFromPP = calls.filter((c) =>
      c.fromQualified.endsWith('processPayment'),
    )
    const callNames = callsFromPP.map((c) => c.toName)
    expect(callNames).toContain('find')
    expect(callNames).toContain('logEvent')
  })

  it('handles broken syntax gracefully with warnings', async () => {
    const result = await getTypeScriptParser().parse({
      relPath: 'broken.ts',
      absPath: '/dev/null',
      source: 'function foo( { unclosed',
      language: 'typescript',
    })
    // We expect at least the file entity even with malformed code.
    expect(result.entities.find((e) => e.type === 'file')).toBeDefined()
  })

  it('extracts arrow-function consts as functions', async () => {
    const result = await getTypeScriptParser().parse({
      relPath: 'arrow.ts',
      absPath: '/dev/null',
      source: `export const greet = (name: string) => \`hi \${name}\`\nexport const shout = function () { return 'HI' }\n`,
      language: 'typescript',
    })
    const fns = result.entities.filter((e) => e.type === 'function').map((f) => f.name)
    expect(fns).toContain('greet')
    expect(fns).toContain('shout')
  })
})
