import type { EntityType, RelationType, Language } from '#shared/types'

export interface ParsedEntity {
  /** Stable per-file identity (e.g. `path::ClassName::methodName`). */
  qualifiedName: string
  name: string
  type: EntityType
  language: Language
  filePath: string
  startLine: number
  endLine: number
  signature?: string
  visibility?: 'public' | 'private'
  metadata?: Record<string, unknown>
}

export interface ParsedRelation {
  fromQualified: string
  toQualified: string
  /**
   * For unresolved targets (calls/imports where the target lives outside the
   * workspace) the parser may emit a name-only hint that the pipeline can try
   * to resolve later.
   */
  toName?: string
  type: RelationType
  evidenceQuote?: string
  metadata?: Record<string, unknown>
}

export interface ParseResult {
  entities: ParsedEntity[]
  relations: ParsedRelation[]
  /** Per-file errors that did not abort parsing. */
  warnings: string[]
}

export interface ParserInput {
  /** Workspace-relative file path (POSIX). */
  relPath: string
  /** Absolute disk path (for parsers that need to read on demand). */
  absPath: string
  /** Source text (read once and shared across parsers). */
  source: string
  language: Language
}

export interface SourceParser {
  language: Language | Language[]
  parse(input: ParserInput): Promise<ParseResult>
}
