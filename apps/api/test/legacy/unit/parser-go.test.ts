import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getGoParser } from '../../server/indexer/parsers/go'

async function parseFixture(relPath: string) {
  const absPath = resolve(__dirname, '../fixtures/repos/go-sample', relPath)
  const source = await readFile(absPath, 'utf-8')
  return getGoParser().parse({
    relPath,
    absPath,
    source,
    language: 'go',
  })
}

describe('go parser', () => {
  it('extracts file entity', async () => {
    const result = await parseFixture('orders.go')
    const file = result.entities.find((e) => e.type === 'file')
    expect(file?.qualifiedName).toBe('orders.go')
  })

  it('extracts struct types and functions', async () => {
    const result = await parseFixture('orders.go')
    const types = result.entities.filter((e) => e.type === 'class').map((t) => t.name).sort()
    expect(types).toEqual(['Order', 'OrderRepository', 'OrderService'])

    const fns = result.entities.filter((e) => e.type === 'function').map((f) => f.name)
    expect(fns).toContain('NewOrderRepository')
    expect(fns).toContain('Save')
    expect(fns).toContain('Find')
    expect(fns).toContain('ProcessPayment')
  })

  it('attaches methods to receivers via contained_in', async () => {
    const result = await parseFixture('orders.go')
    const containedIn = result.relations.filter((r) => r.type === 'contained_in')
    const save = result.entities.find((e) => e.name === 'Save')
    expect(save?.qualifiedName).toContain('::OrderRepository::Save')
    expect(
      containedIn.some(
        (r) =>
          r.fromQualified === save!.qualifiedName &&
          r.toQualified.endsWith('::OrderRepository'),
      ),
    ).toBe(true)
  })

  it('detects capital-letter exported visibility', async () => {
    const result = await parseFixture('orders.go')
    const save = result.entities.find((e) => e.name === 'Save')
    expect(save?.visibility).toBe('public')
  })

  it('extracts imports', async () => {
    const result = await parseFixture('telemetry.go')
    const imports = result.relations.filter((r) => r.type === 'imports').map((r) => r.toName)
    expect(imports).toContain('time')
  })

  it('extracts call relations from method bodies', async () => {
    const result = await parseFixture('orders.go')
    const calls = result.relations.filter((r) => r.type === 'calls')
    const fromProcess = calls
      .filter((c) => c.fromQualified.endsWith('ProcessPayment'))
      .map((c) => c.toName)
    expect(fromProcess).toContain('Find')
    expect(fromProcess).toContain('LogEvent')
  })
})
