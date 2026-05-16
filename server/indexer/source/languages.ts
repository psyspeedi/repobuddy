import type { Language } from '#shared/types'

const EXTENSION_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.vue': 'typescript', // SFC parsed via @vue/compiler-sfc + ts-morph
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
}

const MANIFEST_LANGUAGES: Record<string, Language[]> = {
  'package.json': ['typescript', 'javascript'],
  'tsconfig.json': ['typescript'],
  'pyproject.toml': ['python'],
  'requirements.txt': ['python'],
  'setup.py': ['python'],
  'Pipfile': ['python'],
  'go.mod': ['go'],
  'go.sum': ['go'],
}

export function detectLanguageFromPath(path: string): Language | null {
  const lower = path.toLowerCase()
  for (const [ext, lang] of Object.entries(EXTENSION_MAP)) {
    if (lower.endsWith(ext)) return lang
  }
  return null
}

export function detectLanguagesFromManifest(filename: string): Language[] {
  const lower = filename.toLowerCase()
  for (const [name, langs] of Object.entries(MANIFEST_LANGUAGES)) {
    if (lower === name.toLowerCase()) return langs
  }
  return []
}

/** Aggregate the per-file decisions into a workspace-wide language list. */
export function summariseLanguages(perFile: (Language | null)[]): Language[] {
  const counts = new Map<Language, number>()
  for (const lang of perFile) {
    if (!lang) continue
    counts.set(lang, (counts.get(lang) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang)
}
