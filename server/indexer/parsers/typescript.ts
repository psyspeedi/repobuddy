import {
  Project,
  ScriptKind,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type JSDocableNode,
  type JSDoc,
  type MethodDeclaration,
  type Node,
  type SourceFile,
  type TypeAliasDeclaration,
} from 'ts-morph'
import type {
  ParsedEntity,
  ParsedRelation,
  ParseResult,
  ParserInput,
  SourceParser,
} from './types'
import { getLogger } from '../../lib/logger'

const log = getLogger().child({ component: 'parsers/typescript' })

class TypeScriptParser implements SourceParser {
  readonly language: Array<'typescript' | 'javascript'> = ['typescript', 'javascript']

  // ts-morph Project is heavy — share one instance across files.
  // `useInMemoryFileSystem: true` avoids touching disk; each parse() call
  // adds the single source file and removes it after.
  private project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      allowJs: true,
      jsx: 4, // Preserve
      target: 99, // ESNext
      module: 99, // ESNext
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
    },
  })

  async parse(input: ParserInput): Promise<ParseResult> {
    const entities: ParsedEntity[] = []
    const relations: ParsedRelation[] = []
    const warnings: string[] = []

    const scriptKind = scriptKindFor(input.relPath)
    let sf: SourceFile
    try {
      sf = this.project.createSourceFile(input.relPath, input.source, {
        scriptKind,
        overwrite: true,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`failed to create source file: ${msg}`)
      log.warn({ relPath: input.relPath, err: msg }, 'createSourceFile failed')
      return { entities, relations, warnings }
    }

    // File entity (one per source file).
    const fileQualified = input.relPath
    entities.push({
      qualifiedName: fileQualified,
      name: input.relPath.split('/').pop() ?? input.relPath,
      type: 'file',
      language: input.language,
      filePath: input.relPath,
      startLine: 1,
      endLine: sf.getEndLineNumber(),
    })

    try {
      this.extractImports(sf, input, relations, fileQualified)
      this.extractClasses(sf, input, entities, relations, fileQualified)
      this.extractFunctions(sf, input, entities, relations, fileQualified)
      this.extractInterfacesAndTypes(sf, input, entities, relations, fileQualified)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`extraction error: ${msg}`)
      log.warn({ relPath: input.relPath, err: msg }, 'extraction failed')
    } finally {
      // Drop the source file to keep memory bounded across many files.
      this.project.removeSourceFile(sf)
    }

    return { entities, relations, warnings }
  }

  private extractImports(
    sf: SourceFile,
    input: ParserInput,
    relations: ParsedRelation[],
    fileQualified: string,
  ): void {
    for (const imp of sf.getImportDeclarations()) {
      const spec = imp.getModuleSpecifierValue()
      if (!spec) continue
      const targetQualified = resolveImportTarget(input.relPath, spec)
      relations.push({
        fromQualified: fileQualified,
        toQualified: targetQualified,
        toName: spec,
        type: 'imports',
        evidenceQuote: imp.getText().slice(0, 200),
        metadata: { module: spec, external: !targetQualified.startsWith(input.relPath.split('/')[0] ?? '') },
      })
    }
  }

  private extractClasses(
    sf: SourceFile,
    input: ParserInput,
    entities: ParsedEntity[],
    relations: ParsedRelation[],
    fileQualified: string,
  ): void {
    for (const cls of sf.getClasses()) {
      const name = cls.getName()
      if (!name) continue
      const qualified = `${input.relPath}::${name}`

      entities.push({
        qualifiedName: qualified,
        name,
        type: 'class',
        language: input.language,
        filePath: input.relPath,
        startLine: cls.getStartLineNumber(),
        endLine: cls.getEndLineNumber(),
        signature: classSignature(cls),
        visibility: cls.hasModifier(SyntaxKind.ExportKeyword) ? 'public' : 'private',
        metadata: docsMetadata(cls),
      })

      relations.push({
        fromQualified: qualified,
        toQualified: fileQualified,
        type: 'defined_in',
      })

      // Heritage clauses.
      const extendsExpr = cls.getExtends()
      if (extendsExpr) {
        relations.push({
          fromQualified: qualified,
          toQualified: extendsExpr.getText(),
          toName: extendsExpr.getText(),
          type: 'extends',
          evidenceQuote: extendsExpr.getText(),
        })
      }
      for (const impl of cls.getImplements()) {
        relations.push({
          fromQualified: qualified,
          toQualified: impl.getText(),
          toName: impl.getText(),
          type: 'implements',
          evidenceQuote: impl.getText(),
        })
      }

      // Methods.
      for (const method of cls.getMethods()) {
        this.extractMethod(method, qualified, input, entities, relations)
      }
      for (const ctor of cls.getConstructors()) {
        const methodQualified = `${qualified}::constructor`
        entities.push({
          qualifiedName: methodQualified,
          name: 'constructor',
          type: 'function',
          language: input.language,
          filePath: input.relPath,
          startLine: ctor.getStartLineNumber(),
          endLine: ctor.getEndLineNumber(),
          signature: ctor.getText().split('\n')[0],
          metadata: docsMetadata(ctor),
        })
        relations.push({
          fromQualified: methodQualified,
          toQualified: qualified,
          type: 'contained_in',
        })
        this.extractCalls(ctor, methodQualified, relations)
      }
    }
  }

  private extractMethod(
    method: MethodDeclaration,
    classQualified: string,
    input: ParserInput,
    entities: ParsedEntity[],
    relations: ParsedRelation[],
  ): void {
    const name = method.getName()
    const qualified = `${classQualified}::${name}`
    entities.push({
      qualifiedName: qualified,
      name,
      type: 'function',
      language: input.language,
      filePath: input.relPath,
      startLine: method.getStartLineNumber(),
      endLine: method.getEndLineNumber(),
      signature: method.getText().split('\n')[0],
      visibility: method.hasModifier(SyntaxKind.PrivateKeyword)
        ? 'private'
        : 'public',
      metadata: docsMetadata(method),
    })
    relations.push({
      fromQualified: qualified,
      toQualified: classQualified,
      type: 'contained_in',
    })
    this.extractCalls(method, qualified, relations)
  }

  private extractFunctions(
    sf: SourceFile,
    input: ParserInput,
    entities: ParsedEntity[],
    relations: ParsedRelation[],
    fileQualified: string,
  ): void {
    for (const fn of sf.getFunctions()) {
      const name = fn.getName()
      if (!name) continue
      const qualified = `${input.relPath}::${name}`
      entities.push({
        qualifiedName: qualified,
        name,
        type: 'function',
        language: input.language,
        filePath: input.relPath,
        startLine: fn.getStartLineNumber(),
        endLine: fn.getEndLineNumber(),
        signature: signatureLine(fn),
        visibility: fn.hasModifier(SyntaxKind.ExportKeyword) ? 'public' : 'private',
        metadata: docsMetadata(fn),
      })
      relations.push({
        fromQualified: qualified,
        toQualified: fileQualified,
        type: 'defined_in',
      })
      this.extractCalls(fn, qualified, relations)
    }

    // Arrow-function consts / function-expression consts assigned at top level.
    for (const varStmt of sf.getVariableStatements()) {
      for (const decl of varStmt.getDeclarations()) {
        const init = decl.getInitializer()
        if (!init) continue
        const isFn =
          init.getKind() === SyntaxKind.ArrowFunction ||
          init.getKind() === SyntaxKind.FunctionExpression
        if (!isFn) continue
        const name = decl.getName()
        const qualified = `${input.relPath}::${name}`
        entities.push({
          qualifiedName: qualified,
          name,
          type: 'function',
          language: input.language,
          filePath: input.relPath,
          startLine: decl.getStartLineNumber(),
          endLine: decl.getEndLineNumber(),
          signature: signatureLine(decl),
          visibility: varStmt.hasModifier(SyntaxKind.ExportKeyword) ? 'public' : 'private',
          // JSDoc lives on the VariableStatement (`/** ... */ export const fn = …`),
          // not on the declarator — getJsDocs() returns [] on VariableDeclaration.
          metadata: docsMetadata(varStmt),
        })
        relations.push({
          fromQualified: qualified,
          toQualified: fileQualified,
          type: 'defined_in',
        })
        this.extractCalls(init, qualified, relations)
      }
    }
  }

  private extractInterfacesAndTypes(
    sf: SourceFile,
    input: ParserInput,
    entities: ParsedEntity[],
    relations: ParsedRelation[],
    fileQualified: string,
  ): void {
    for (const ifaceRaw of sf.getInterfaces()) {
      const iface: InterfaceDeclaration = ifaceRaw
      const name = iface.getName()
      const qualified = `${input.relPath}::${name}`
      entities.push({
        qualifiedName: qualified,
        name,
        type: 'type',
        language: input.language,
        filePath: input.relPath,
        startLine: iface.getStartLineNumber(),
        endLine: iface.getEndLineNumber(),
        signature: `interface ${name}`,
        visibility: iface.hasModifier(SyntaxKind.ExportKeyword) ? 'public' : 'private',
        metadata: docsMetadata(iface),
      })
      relations.push({
        fromQualified: qualified,
        toQualified: fileQualified,
        type: 'defined_in',
      })
    }
    for (const aliasRaw of sf.getTypeAliases()) {
      const alias: TypeAliasDeclaration = aliasRaw
      const name = alias.getName()
      const qualified = `${input.relPath}::${name}`
      entities.push({
        qualifiedName: qualified,
        name,
        type: 'type',
        language: input.language,
        filePath: input.relPath,
        startLine: alias.getStartLineNumber(),
        endLine: alias.getEndLineNumber(),
        signature: `type ${name}`,
        visibility: alias.hasModifier(SyntaxKind.ExportKeyword) ? 'public' : 'private',
        metadata: docsMetadata(alias),
      })
      relations.push({
        fromQualified: qualified,
        toQualified: fileQualified,
        type: 'defined_in',
      })
    }
  }

  private extractCalls(
    container: Node,
    fromQualified: string,
    relations: ParsedRelation[],
  ): void {
    const calls = container.getDescendantsOfKind(SyntaxKind.CallExpression) as CallExpression[]
    for (const call of calls) {
      const expr = call.getExpression()
      const name = callTargetName(expr)
      if (!name) continue
      relations.push({
        fromQualified,
        toQualified: name,
        toName: name,
        type: 'calls',
        evidenceQuote: call.getText().slice(0, 200),
      })
    }
  }
}

function scriptKindFor(relPath: string): ScriptKind {
  if (relPath.endsWith('.tsx')) return ScriptKind.TSX
  if (relPath.endsWith('.jsx')) return ScriptKind.JSX
  if (/\.(js|mjs|cjs)$/.test(relPath)) return ScriptKind.JS
  return ScriptKind.TS
}

function resolveImportTarget(from: string, spec: string): string {
  if (spec.startsWith('.')) {
    const segments = from.split('/').slice(0, -1)
    for (const part of spec.split('/')) {
      if (part === '..') segments.pop()
      else if (part !== '.') segments.push(part)
    }
    return segments.join('/')
  }
  return spec
}

function classSignature(cls: ClassDeclaration): string {
  const exp = cls.hasModifier(SyntaxKind.ExportKeyword) ? 'export ' : ''
  return `${exp}class ${cls.getName() ?? ''}`
}

function signatureLine(node: Node): string {
  return node.getText().split('\n')[0]?.slice(0, 200) ?? ''
}

interface ParsedDocs {
  description: string
  params?: { name: string; description: string }[]
  returns?: string
  examples?: string[]
  deprecated?: string | true
  tags?: { name: string; text: string }[]
}

// Extract author-written JSDoc into structured metadata. Libraries that
// document themselves (lodash, p-limit, zod helpers, …) carry the
// source-of-truth API description here, so the annotation phase and the
// answer operator can ground on real prose instead of regenerating it.
function docsMetadata(
  node: JSDocableNode & Node,
): { docs: ParsedDocs } | undefined {
  let docs: JSDoc[] = []
  try {
    docs = node.getJsDocs()
  } catch {
    return undefined
  }
  if (docs.length === 0) return undefined
  // Multiple JSDoc blocks above one declaration are unusual but legal —
  // the convention in TS lib types is to pick the last block (closest to
  // the declaration).
  const block = docs[docs.length - 1]
  if (!block) return undefined
  const description = block.getDescription().trim()
  const params: { name: string; description: string }[] = []
  const examples: string[] = []
  const tags: { name: string; text: string }[] = []
  let returns: string | undefined
  let deprecated: string | true | undefined

  for (const tag of block.getTags()) {
    const tagName = tag.getTagName()
    const text = (tag.getCommentText() ?? '').trim()
    switch (tagName) {
      case 'param':
      case 'parameter': {
        const m = /^(\S+)\s*-?\s*(.*)$/s.exec(text)
        if (m) params.push({ name: m[1] ?? '', description: (m[2] ?? '').trim() })
        else if (text) params.push({ name: '', description: text })
        break
      }
      case 'returns':
      case 'return':
        if (text) returns = text
        break
      case 'example':
        if (text) examples.push(text)
        break
      case 'deprecated':
        deprecated = text || true
        break
      default:
        if (text) tags.push({ name: tagName, text })
    }
  }

  if (
    !description
    && params.length === 0
    && !returns
    && examples.length === 0
    && deprecated === undefined
    && tags.length === 0
  ) {
    return undefined
  }
  const out: ParsedDocs = { description }
  if (params.length > 0) out.params = params
  if (returns) out.returns = returns
  if (examples.length > 0) out.examples = examples
  if (deprecated !== undefined) out.deprecated = deprecated
  if (tags.length > 0) out.tags = tags
  return { docs: out }
}

function callTargetName(expr: Node): string | null {
  // Identifier — direct call: `foo(...)`
  if (expr.getKind() === SyntaxKind.Identifier) {
    return expr.getText()
  }
  // PropertyAccess — method call: `this.repo.save(...)` → "save"
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    return (expr.getLastChild()?.getText() ?? expr.getText().split('.').pop()) ?? null
  }
  return null
}

let singleton: TypeScriptParser | null = null

export function getTypeScriptParser(): TypeScriptParser {
  if (!singleton) singleton = new TypeScriptParser()
  return singleton
}
