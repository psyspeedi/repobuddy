import { getParser, type SyntaxNode as TSNode } from './tree-sitter-loader'
import type {
  ParsedEntity,
  ParsedRelation,
  ParseResult,
  ParserInput,
  SourceParser,
} from './types'
import { getLogger } from '../../lib/logger'

const log = getLogger().child({ component: 'parsers/go' })

class GoParser implements SourceParser {
  readonly language = 'go' as const

  async parse(input: ParserInput): Promise<ParseResult> {
    const entities: ParsedEntity[] = []
    const relations: ParsedRelation[] = []
    const warnings: string[] = []

    let parser: Awaited<ReturnType<typeof getParser>>
    try {
      parser = await getParser('go')
    } catch (err) {
      warnings.push(
        `tree-sitter init failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return { entities, relations, warnings }
    }

    const tree = parser.parse(input.source)
    const root = tree?.rootNode
    if (!root) {
      warnings.push('empty parse tree')
      return { entities, relations, warnings }
    }

    const fileQualified = input.relPath
    entities.push({
      qualifiedName: fileQualified,
      name: input.relPath.split('/').pop() ?? input.relPath,
      type: 'file',
      language: 'go',
      filePath: input.relPath,
      startLine: 1,
      endLine: root.endPosition.row + 1,
    })

    try {
      // Top-level declarations only; methods and functions are at file scope in Go.
      for (let i = 0; i < root.namedChildCount; i++) {
        const node = root.namedChild(i)
        if (!node) continue
        switch (node.type) {
          case 'import_declaration':
            handleImports(node, relations, fileQualified)
            break
          case 'type_declaration':
            handleTypeDeclaration(node, input, entities, relations, fileQualified)
            break
          case 'function_declaration':
            handleFunction(node, input, entities, relations, fileQualified)
            break
          case 'method_declaration':
            handleMethod(node, input, entities, relations, fileQualified)
            break
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`walk error: ${msg}`)
      log.warn({ relPath: input.relPath, err: msg }, 'walk failed')
    } finally {
      tree?.delete()
    }

    return { entities, relations, warnings }
  }
}

function handleImports(
  node: TSNode,
  relations: ParsedRelation[],
  fileQualified: string,
): void {
  // Either a single `import "fmt"` or an `import ( ... )` spec list.
  const collect = (specNode: TSNode): void => {
    const pathNode = specNode.childForFieldName('path') ?? specNode.namedChild(0)
    const raw = pathNode?.text ?? ''
    const cleaned = raw.replace(/^"|"$/g, '')
    if (cleaned) {
      relations.push({
        fromQualified: fileQualified,
        toQualified: cleaned,
        toName: cleaned,
        type: 'imports',
        evidenceQuote: specNode.text.slice(0, 200),
      })
    }
  }

  const specList = node.childForFieldName('import_spec_list')
  if (specList) {
    for (let i = 0; i < specList.namedChildCount; i++) {
      const spec = specList.namedChild(i)
      if (spec && spec.type === 'import_spec') collect(spec)
    }
  } else {
    for (let i = 0; i < node.namedChildCount; i++) {
      const spec = node.namedChild(i)
      if (spec && spec.type === 'import_spec') collect(spec)
    }
  }
}

function handleTypeDeclaration(
  node: TSNode,
  input: ParserInput,
  entities: ParsedEntity[],
  relations: ParsedRelation[],
  fileQualified: string,
): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const spec = node.namedChild(i)
    if (!spec || spec.type !== 'type_spec') continue
    const nameNode = spec.childForFieldName('name') ?? spec.namedChild(0)
    const name = nameNode?.text
    if (!name) continue
    const qualified = `${input.relPath}::${name}`
    const isStruct = spec.text.includes('struct')
    entities.push({
      qualifiedName: qualified,
      name,
      type: isStruct ? 'class' : 'type',
      language: 'go',
      filePath: input.relPath,
      startLine: spec.startPosition.row + 1,
      endLine: spec.endPosition.row + 1,
      signature: firstLine(spec.text),
      visibility: /^[A-Z]/.test(name) ? 'public' : 'private',
    })
    relations.push({
      fromQualified: qualified,
      toQualified: fileQualified,
      type: 'defined_in',
    })
  }
}

function handleFunction(
  node: TSNode,
  input: ParserInput,
  entities: ParsedEntity[],
  relations: ParsedRelation[],
  fileQualified: string,
): void {
  const nameNode = node.childForFieldName('name')
  const name = nameNode?.text
  if (!name) return
  const qualified = `${input.relPath}::${name}`
  entities.push({
    qualifiedName: qualified,
    name,
    type: 'function',
    language: 'go',
    filePath: input.relPath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: firstLine(node.text),
    visibility: /^[A-Z]/.test(name) ? 'public' : 'private',
  })
  relations.push({
    fromQualified: qualified,
    toQualified: fileQualified,
    type: 'defined_in',
  })
  collectCallsFromBody(node, qualified, relations)
}

function handleMethod(
  node: TSNode,
  input: ParserInput,
  entities: ParsedEntity[],
  relations: ParsedRelation[],
  fileQualified: string,
): void {
  const nameNode = node.childForFieldName('name')
  const name = nameNode?.text
  if (!name) return

  // Receiver name (e.g., `(r *OrderRepository)` → "OrderRepository").
  let receiverType = ''
  const receiver = node.childForFieldName('receiver')
  if (receiver) {
    const last = receiver.descendantsOfType('type_identifier').pop()
    receiverType = last?.text ?? ''
  }

  const qualified = receiverType
    ? `${input.relPath}::${receiverType}::${name}`
    : `${input.relPath}::${name}`

  entities.push({
    qualifiedName: qualified,
    name,
    type: 'function',
    language: 'go',
    filePath: input.relPath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: firstLine(node.text),
    visibility: /^[A-Z]/.test(name) ? 'public' : 'private',
  })

  if (receiverType) {
    relations.push({
      fromQualified: qualified,
      toQualified: `${input.relPath}::${receiverType}`,
      type: 'contained_in',
    })
  } else {
    relations.push({
      fromQualified: qualified,
      toQualified: fileQualified,
      type: 'defined_in',
    })
  }

  collectCallsFromBody(node, qualified, relations)
}

function collectCallsFromBody(
  fnNode: TSNode,
  fromQualified: string,
  relations: ParsedRelation[],
): void {
  const body = fnNode.childForFieldName('body')
  if (!body) return
  const visit = (n: TSNode): void => {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function')
      if (fn) {
        const targetName = fn.type === 'selector_expression'
          ? fn.childForFieldName('field')?.text ?? fn.text
          : fn.text
        relations.push({
          fromQualified,
          toQualified: targetName,
          toName: targetName,
          type: 'calls',
          evidenceQuote: n.text.slice(0, 200),
        })
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i)
      if (c) visit(c)
    }
  }
  visit(body)
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 200) ?? ''
}

let singleton: GoParser | null = null
export function getGoParser(): GoParser {
  if (!singleton) singleton = new GoParser()
  return singleton
}
