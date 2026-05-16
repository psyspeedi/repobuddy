import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getPythonParser } from '../../server/indexer/parsers/python'

async function parseFixture(relPath: string) {
  const absPath = resolve(__dirname, '../fixtures/repos/py-sample', relPath)
  const source = await readFile(absPath, 'utf-8')
  return getPythonParser().parse({
    relPath,
    absPath,
    source,
    language: 'python',
  })
}

describe('python parser', () => {
  it('extracts file entity', async () => {
    const result = await parseFixture('orders.py')
    const file = result.entities.find((e) => e.type === 'file')
    expect(file?.qualifiedName).toBe('orders.py')
  })

  it('extracts class declarations and methods', async () => {
    const result = await parseFixture('orders.py')
    const classes = result.entities.filter((e) => e.type === 'class').map((c) => c.name).sort()
    expect(classes).toEqual(['Order', 'OrderRepository', 'OrderService'])

    const methods = result.entities.filter((e) => e.type === 'function').map((m) => m.name)
    expect(methods).toContain('save')
    expect(methods).toContain('find')
    expect(methods).toContain('process_payment')
    expect(methods).toContain('__init__')
  })

  it('builds contained_in for methods', async () => {
    const result = await parseFixture('orders.py')
    const containedIn = result.relations.filter((r) => r.type === 'contained_in')
    const processPaymentEntity = result.entities.find((e) => e.name === 'process_payment')
    expect(processPaymentEntity).toBeDefined()
    expect(
      containedIn.some((r) => r.fromQualified === processPaymentEntity!.qualifiedName),
    ).toBe(true)
  })

  it('extracts imports', async () => {
    const result = await parseFixture('orders.py')
    const imports = result.relations.filter((r) => r.type === 'imports').map((r) => r.toName)
    expect(imports).toContain('telemetry')
    expect(imports.some((i) => i?.includes('dataclasses'))).toBe(true)
  })

  it('extracts call relations within methods', async () => {
    const result = await parseFixture('orders.py')
    const calls = result.relations.filter((r) => r.type === 'calls')
    const fromPP = calls
      .filter((c) => c.fromQualified.endsWith('process_payment'))
      .map((c) => c.toName)
    expect(fromPP).toContain('find')
    expect(fromPP).toContain('log_event')
  })

  it('marks dunder methods (private heuristic with underscore prefix is dropped for __dunder__)', async () => {
    const result = await parseFixture('orders.py')
    // We expect __init__ extracted (single-underscore would be private by our rule).
    const init = result.entities.find((e) => e.name === '__init__')
    expect(init).toBeDefined()
  })

  it('does not crash on syntactically broken input', async () => {
    const result = await getPythonParser().parse({
      relPath: 'broken.py',
      absPath: '/dev/null',
      source: 'def foo(:\n  return',
      language: 'python',
    })
    expect(result.entities.find((e) => e.type === 'file')).toBeDefined()
  })
})
