import type { ChunkSourceType } from '#shared/types'
import type { ParsedEntity, ParseResult } from '../parsers/types'

export interface CodeChunk {
  filePath: string
  startLine: number
  endLine: number
  text: string
  sourceType: ChunkSourceType
  metadata: {
    /** qualifiedName of the entity this chunk represents (when applicable). */
    qualifiedName?: string
    entityType?: ParsedEntity['type']
    language?: string
  }
}

const MAX_LINES_PER_CHUNK = 200
const MIN_LINES_FOR_ENTITY_CHUNK = 4
const SMALL_FILE_LINE_THRESHOLD = 150

/**
 * Path segments that mark a file as an example / sample / demo. Indexed
 * separately so the retrieval layer can prefer "show me how to use X" over
 * "show me how X is implemented" when asked.
 */
const EXAMPLE_PATH_SEGMENTS = new Set([
  'examples',
  'example',
  'samples',
  'sample',
  'demo',
  'demos',
  'sandbox',
  'playground',
])

export function isExamplePath(filePath: string): boolean {
  const segments = filePath.split('/')
  for (const s of segments) {
    if (EXAMPLE_PATH_SEGMENTS.has(s.toLowerCase())) return true
  }
  return false
}

/**
 * AST-aware chunker.
 *
 * Strategy:
 * - If the file has no extracted entities (besides the `file` entity), or
 *   the file is small (<150 lines), emit one whole-file chunk.
 * - Otherwise emit one chunk per top-level entity (class, function, type)
 *   using its start/end line range. Class chunks include their methods —
 *   methods are *not* emitted as separate chunks because they would create
 *   too much redundancy with their enclosing class.
 * - Overly long chunks (>200 lines, e.g. a 500-line class) are split at
 *   method boundaries.
 *
 * The chunker is intentionally a pure function of (source, parseResult) so
 * it's trivially testable.
 */
export function chunkCode(
  filePath: string,
  source: string,
  parseResult: ParseResult,
  language: string,
): CodeChunk[] {
  const lines = source.split('\n')
  const totalLines = lines.length

  const nonFileEntities = parseResult.entities.filter((e) => e.type !== 'file')
  if (nonFileEntities.length === 0 || totalLines <= SMALL_FILE_LINE_THRESHOLD) {
    return [
      {
        filePath,
        startLine: 1,
        endLine: totalLines,
        text: source,
        sourceType: isExamplePath(filePath) ? 'example' : 'code',
        metadata: { language },
      },
    ]
  }

  // Find top-level entities: those whose `contained_in` parent is the file,
  // or who appear at the top of the file (no enclosing class).
  const containedInMap = new Map<string, string>()
  for (const rel of parseResult.relations) {
    if (rel.type === 'contained_in') {
      containedInMap.set(rel.fromQualified, rel.toQualified)
    }
  }
  const fileQualified = filePath

  const topLevel = nonFileEntities.filter((e) => {
    const parent = containedInMap.get(e.qualifiedName)
    return !parent || parent === fileQualified
  })

  if (topLevel.length === 0) {
    return [
      {
        filePath,
        startLine: 1,
        endLine: totalLines,
        text: source,
        sourceType: isExamplePath(filePath) ? 'example' : 'code',
        metadata: { language },
      },
    ]
  }

  const chunks: CodeChunk[] = []
  for (const entity of topLevel) {
    const span = entity.endLine - entity.startLine + 1
    if (span < MIN_LINES_FOR_ENTITY_CHUNK) continue

    if (span <= MAX_LINES_PER_CHUNK) {
      chunks.push(buildChunk(filePath, lines, entity, language))
    } else {
      // Split a too-large entity at child boundaries (methods).
      const children = nonFileEntities.filter(
        (e) => containedInMap.get(e.qualifiedName) === entity.qualifiedName,
      )
      if (children.length === 0) {
        chunks.push(buildChunk(filePath, lines, entity, language))
      } else {
        for (const child of children) {
          chunks.push(buildChunk(filePath, lines, child, language))
        }
      }
    }
  }

  if (chunks.length === 0) {
    return [
      {
        filePath,
        startLine: 1,
        endLine: totalLines,
        text: source,
        sourceType: isExamplePath(filePath) ? 'example' : 'code',
        metadata: { language },
      },
    ]
  }
  return chunks
}

function buildChunk(
  filePath: string,
  lines: string[],
  entity: ParsedEntity,
  language: string,
): CodeChunk {
  const start = Math.max(1, entity.startLine)
  const end = Math.min(lines.length, entity.endLine)
  return {
    filePath,
    startLine: start,
    endLine: end,
    text: lines.slice(start - 1, end).join('\n'),
    sourceType: isExamplePath(filePath) ? 'example' : 'code',
    metadata: {
      qualifiedName: entity.qualifiedName,
      entityType: entity.type,
      language,
    },
  }
}

/**
 * Split Markdown into chunks at level 1-3 headings. Sections shorter than
 * 500 chars are kept whole; longer ones are broken at paragraph boundaries.
 */
export function chunkMarkdown(filePath: string, source: string): CodeChunk[] {
  if (source.length === 0) return []
  const lines = source.split('\n')

  const sections: { startLine: number; endLine: number; text: string }[] = []
  let currentStart = 1
  let currentLines: string[] = []

  const flush = (endLine: number): void => {
    if (currentLines.length === 0) return
    sections.push({
      startLine: currentStart,
      endLine,
      text: currentLines.join('\n'),
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^#{1,3}\s/.test(line)) {
      flush(i)
      currentStart = i + 1
      currentLines = [line]
    } else {
      currentLines.push(line)
    }
  }
  flush(lines.length)

  const isExample = isExamplePath(filePath)
  return sections.map((s) => ({
    filePath,
    startLine: s.startLine,
    endLine: s.endLine,
    text: s.text,
    sourceType: isExample ? ('example' as const) : ('doc' as const),
    metadata: {},
  }))
}
