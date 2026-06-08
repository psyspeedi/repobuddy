import { join } from 'node:path'
import Parser from 'web-tree-sitter'

const GRAMMAR_DIR = join(
  process.cwd(),
  'node_modules',
  'tree-sitter-wasms',
  'out',
)

let initPromise: Promise<void> | null = null
const cache = new Map<string, Parser.Language>()

/**
 * Singleton initialiser. Multiple concurrent callers safely await the same
 * promise. Required by web-tree-sitter before any Language.load() call.
 */
async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init()
  }
  await initPromise
}

export async function loadGrammar(
  name: 'python' | 'go' | 'javascript',
): Promise<Parser.Language> {
  await ensureInit()
  const cached = cache.get(name)
  if (cached) return cached

  const path = join(GRAMMAR_DIR, `tree-sitter-${name}.wasm`)
  const lang = await Parser.Language.load(path)
  cache.set(name, lang)
  return lang
}

export async function getParser(
  grammar: 'python' | 'go' | 'javascript',
): Promise<Parser> {
  const lang = await loadGrammar(grammar)
  const parser = new Parser()
  parser.setLanguage(lang)
  return parser
}

export type { Parser }
export type SyntaxNode = Parser.SyntaxNode
