import { getParser, type SyntaxNode as TSNode } from './tree-sitter-loader'
import type {
  ParsedEntity,
  ParsedRelation,
  ParseResult,
  ParserInput,
  SourceParser,
} from './types'
import { getLogger } from '#server/lib/logger'

const log = getLogger().child({ component: 'parsers/python' })

class PythonParser implements SourceParser {
  readonly language = 'python' as const

  async parse(input: ParserInput): Promise<ParseResult> {
    const entities: ParsedEntity[] = []
    const relations: ParsedRelation[] = []
    const warnings: string[] = []

    let parser: Awaited<ReturnType<typeof getParser>>
    try {
      parser = await getParser('python')
    } catch (err) {
      warnings.push(`tree-sitter init failed: ${err instanceof Error ? err.message : String(err)}`)
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
      language: 'python',
      filePath: input.relPath,
      startLine: 1,
      endLine: root.endPosition.row + 1,
    })

    try {
      walk(root, (node, parentQualified) => {
        switch (node.type) {
          case 'import_statement':
          case 'import_from_statement':
            return handleImport(node, relations, fileQualified)
          case 'class_definition':
            return handleClass(node, input, entities, relations, parentQualified)
          case 'function_definition':
            return handleFunction(node, input, entities, relations, parentQualified)
          default:
            return parentQualified
        }
      }, fileQualified)
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

type WalkVisitor = (
  node: TSNode,
  parentQualified: string,
) => string | undefined

/** Recursive descent over named children, threading the qualified-name scope. */
function walk(node: TSNode, visit: WalkVisitor, parentQualified: string): void {
  const next = visit(node, parentQualified) ?? parentQualified
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child) walk(child, visit, next)
  }
}

function handleImport(
  node: TSNode,
  relations: ParsedRelation[],
  fileQualified: string,
): string {
  if (node.type === 'import_statement') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (!child) continue
      const moduleName = child.text
      relations.push({
        fromQualified: fileQualified,
        toQualified: moduleName,
        toName: moduleName,
        type: 'imports',
        evidenceQuote: node.text.slice(0, 200),
      })
    }
  } else if (node.type === 'import_from_statement') {
    const moduleNode = node.childForFieldName('module_name')
    const moduleName = moduleNode?.text ?? 'unknown'
    relations.push({
      fromQualified: fileQualified,
      toQualified: moduleName,
      toName: moduleName,
      type: 'imports',
      evidenceQuote: node.text.slice(0, 200),
    })
  }
  return fileQualified
}

function handleClass(
  node: TSNode,
  input: ParserInput,
  entities: ParsedEntity[],
  relations: ParsedRelation[],
  parentQualified: string,
): string {
  const nameNode = node.childForFieldName('name')
  const name = nameNode?.text
  if (!name) return parentQualified
  const qualified = `${input.relPath}::${name}`

  entities.push({
    qualifiedName: qualified,
    name,
    type: 'class',
    language: 'python',
    filePath: input.relPath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: `class ${name}`,
  })
  relations.push({
    fromQualified: qualified,
    toQualified: parentQualified,
    type: 'defined_in',
  })

  // superclasses live in the argument_list following the name.
  const bases = node.childForFieldName('superclasses')
  if (bases) {
    for (let i = 0; i < bases.namedChildCount; i++) {
      const base = bases.namedChild(i)
      if (!base) continue
      relations.push({
        fromQualified: qualified,
        toQualified: base.text,
        toName: base.text,
        type: 'extends',
        evidenceQuote: base.text,
      })
    }
  }

  // Extract calls from the class body but exclude nested function bodies — those
  // belong to methods, not the class itself.
  collectCallsExcludingNestedFunctions(node, qualified, relations)
  return qualified
}

function handleFunction(
  node: TSNode,
  input: ParserInput,
  entities: ParsedEntity[],
  relations: ParsedRelation[],
  parentQualified: string,
): string {
  const nameNode = node.childForFieldName('name')
  const name = nameNode?.text
  if (!name) return parentQualified
  const qualified = `${parentQualified}::${name}`

  entities.push({
    qualifiedName: qualified,
    name,
    type: 'function',
    language: 'python',
    filePath: input.relPath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: firstLine(node.text),
    visibility: name.startsWith('_') ? 'private' : 'public',
  })
  relations.push({
    fromQualified: qualified,
    toQualified: parentQualified,
    type: 'contained_in',
  })

  collectCallsExcludingNestedFunctions(node, qualified, relations)
  return qualified
}

/**
 * Walk a subtree, collecting `call` expressions but skipping over nested
 * function/class definitions — their calls are attributed to those scopes,
 * not the enclosing one.
 */
function collectCallsExcludingNestedFunctions(
  root: TSNode,
  fromQualified: string,
  relations: ParsedRelation[],
): void {
  const isScopeBoundary = (n: TSNode): boolean =>
    n.type === 'function_definition' || n.type === 'class_definition'

  const visit = (node: TSNode): void => {
    if (node !== root && isScopeBoundary(node)) return
    if (node.type === 'call') {
      const fn = node.childForFieldName('function')
      if (fn) {
        const targetName = fn.type === 'attribute'
          ? fn.childForFieldName('attribute')?.text ?? fn.text
          : fn.text
        relations.push({
          fromQualified,
          toQualified: targetName,
          toName: targetName,
          type: 'calls',
          evidenceQuote: node.text.slice(0, 200),
        })
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child) visit(child)
    }
  }
  visit(root)
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 200) ?? ''
}

let singleton: PythonParser | null = null
export function getPythonParser(): PythonParser {
  if (!singleton) singleton = new PythonParser()
  return singleton
}
