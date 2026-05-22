/**
 * Distilled "how to run this locally" guide for the welcome overlay.
 *
 * Pulls deterministic signals (no LLM cost) from chunks the indexer
 * already produced:
 *   - package.json scripts (start / dev / build / test)
 *   - pyproject.toml scripts + dependencies declaration
 *   - Makefile targets (first 8)
 *   - Dockerfile / docker-compose presence
 *   - README sections under Install / Setup / Quick start / Getting started
 *
 * Returns a small payload the UI can render as 3-5 numbered steps.
 * The point is to answer "what do I type to make this run?" without
 * making the contributor read the whole README — the most common
 * onboarding blocker.
 */
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { chunks } from '../../../db/schema'
import { readAccess } from '../../../lib/workspace-access'

interface SetupStep {
  kind: 'install' | 'env' | 'run' | 'test' | 'docker' | 'note'
  label: string
  command: string | null
  source: string
}
interface SetupGuide {
  steps: SetupStep[]
  signals: {
    packageManager: 'pnpm' | 'yarn' | 'npm' | 'bun' | null
    hasDocker: boolean
    hasDockerCompose: boolean
    hasMakefile: boolean
    hasPyproject: boolean
    hasGoMod: boolean
    hasCargoToml: boolean
  }
  readmeQuickStart: string | null
}

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')
  if (!workspaceId) throw createError({ statusCode: 400, statusMessage: 'id required' })
  await readAccess(event, workspaceId)

  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)

  // Shallowest-path-first so the root manifests + top-level README come
  // first, even when the repo has dozens of nested package.json files
  // (example: example collections, monorepos). Limit raised to 80 to
  // tolerate big monorepos where many manifests share the same depth.
  const signalFiles = await db
    .select({ filePath: chunks.filePath, text: chunks.text })
    .from(chunks)
    .where(
      and(
        eq(chunks.workspaceId, workspaceId),
        sql`(
          ${chunks.filePath} LIKE '%package.json'
          OR ${chunks.filePath} LIKE '%pyproject.toml'
          OR ${chunks.filePath} LIKE '%/Makefile'
          OR ${chunks.filePath} = 'Makefile'
          OR ${chunks.filePath} LIKE '%/Dockerfile'
          OR ${chunks.filePath} = 'Dockerfile'
          OR lower(${chunks.filePath}) LIKE '%docker-compose%'
          OR lower(${chunks.filePath}) LIKE '%readme%'
          OR ${chunks.filePath} = 'go.mod'
          OR ${chunks.filePath} LIKE '%/go.mod'
          OR ${chunks.filePath} = 'Cargo.toml'
        )`,
      ),
    )
    .orderBy(sql`length(${chunks.filePath}) ASC`)
    .limit(80)

  const guide: SetupGuide = {
    steps: [],
    signals: {
      packageManager: null,
      hasDocker: false,
      hasDockerCompose: false,
      hasMakefile: false,
      hasPyproject: false,
      hasGoMod: false,
      hasCargoToml: false,
    },
    readmeQuickStart: null,
  }

  // Collect by file kind. We keep just the top-level package.json /
  // pyproject etc — nested ones in fixtures or workspaces would
  // distort the guide.
  let topPackageJson: { path: string; text: string } | null = null
  let topPyproject: { path: string; text: string } | null = null
  let topMakefile: { path: string; text: string } | null = null
  let readmeText: { path: string; text: string } | null = null

  for (const c of signalFiles) {
    const path = c.filePath ?? ''
    const depth = path.split('/').length
    const text = c.text
    if (path.endsWith('package.json')) {
      if (!topPackageJson || depth < topPackageJson.path.split('/').length) {
        topPackageJson = { path, text }
      }
    } else if (path.endsWith('pyproject.toml')) {
      guide.signals.hasPyproject = true
      if (!topPyproject || depth < topPyproject.path.split('/').length) {
        topPyproject = { path, text }
      }
    } else if (path.endsWith('Makefile') || path === 'Makefile') {
      guide.signals.hasMakefile = true
      if (!topMakefile || depth < topMakefile.path.split('/').length) {
        topMakefile = { path, text }
      }
    } else if (path.endsWith('Dockerfile') || path === 'Dockerfile') {
      guide.signals.hasDocker = true
    } else if (path.toLowerCase().includes('docker-compose')) {
      guide.signals.hasDockerCompose = true
    } else if (path === 'go.mod' || path.endsWith('/go.mod')) {
      guide.signals.hasGoMod = true
    } else if (path === 'Cargo.toml') {
      guide.signals.hasCargoToml = true
    } else if (path.toLowerCase().includes('readme')) {
      if (!readmeText || depth < readmeText.path.split('/').length) {
        readmeText = { path, text }
      }
    }
  }

  // 1. Package manager + install + dev/start/test scripts.
  if (topPackageJson) {
    try {
      const pkg = JSON.parse(topPackageJson.text) as {
        scripts?: Record<string, string>
        packageManager?: string
      }
      const pm = detectPackageManager(pkg)
      guide.signals.packageManager = pm
      guide.steps.push({
        kind: 'install',
        label: 'Install dependencies',
        command: `${pm} install`,
        source: topPackageJson.path,
      })
      const scripts = pkg.scripts ?? {}
      const devScript = pickScript(scripts, ['dev', 'start', 'serve'])
      if (devScript) {
        guide.steps.push({
          kind: 'run',
          label: 'Run the app',
          command: `${pm} ${pmRunPrefix(pm)} ${devScript}`,
          source: topPackageJson.path,
        })
      }
      const testScript = pickScript(scripts, ['test', 'test:unit'])
      if (testScript) {
        guide.steps.push({
          kind: 'test',
          label: 'Run tests',
          command: `${pm} ${pmRunPrefix(pm)} ${testScript}`,
          source: topPackageJson.path,
        })
      }
    } catch {
      // malformed — skip silently, README section will compensate
    }
  }

  // 2. Python — pyproject signals an install path.
  if (topPyproject && !topPackageJson) {
    const hasPoetry = topPyproject.text.includes('[tool.poetry]')
    const hasUv = topPyproject.text.includes('[tool.uv]') || topPyproject.text.includes('uv.lock')
    const installCmd = hasPoetry ? 'poetry install' : hasUv ? 'uv sync' : 'pip install -e .'
    guide.steps.push({
      kind: 'install',
      label: 'Install dependencies',
      command: installCmd,
      source: topPyproject.path,
    })
    const scriptMatch = topPyproject.text.match(/\[project\.scripts\]([\s\S]*?)(?=\n\[|\n*$)/)
    if (scriptMatch && scriptMatch[1]) {
      const firstScript = scriptMatch[1].match(/^\s*([a-zA-Z0-9_-]+)\s*=/m)
      if (firstScript && firstScript[1]) {
        guide.steps.push({
          kind: 'run',
          label: 'Run the CLI',
          command: hasPoetry ? `poetry run ${firstScript[1]}` : firstScript[1],
          source: topPyproject.path,
        })
      }
    }
  }

  // 3. Go — go.mod presence is enough to suggest the canonical build line.
  if (guide.signals.hasGoMod && !topPackageJson) {
    guide.steps.push({
      kind: 'install',
      label: 'Fetch dependencies',
      command: 'go mod download',
      source: 'go.mod',
    })
    guide.steps.push({
      kind: 'run',
      label: 'Build & run',
      command: 'go run ./...',
      source: 'go.mod',
    })
  }

  // 4. Rust — Cargo.
  if (guide.signals.hasCargoToml && !topPackageJson) {
    guide.steps.push({
      kind: 'install',
      label: 'Build dependencies',
      command: 'cargo build',
      source: 'Cargo.toml',
    })
    guide.steps.push({
      kind: 'run',
      label: 'Run',
      command: 'cargo run',
      source: 'Cargo.toml',
    })
  }

  // 5. Docker Compose — a one-liner that often beats the language setup.
  if (guide.signals.hasDockerCompose) {
    guide.steps.unshift({
      kind: 'docker',
      label: 'Or use Docker Compose',
      command: 'docker compose up',
      source: 'docker-compose.yml',
    })
  }

  // 6. Makefile — surface the first few targets as a hint, no command guessing.
  if (topMakefile) {
    const targets = extractMakeTargets(topMakefile.text).slice(0, 5)
    if (targets.length > 0) {
      guide.steps.push({
        kind: 'note',
        label: 'Makefile targets',
        command: targets.map((t) => `make ${t}`).join('   '),
        source: topMakefile.path,
      })
    }
  }

  // 7. README "Quick start" / "Installation" section — verbatim excerpt.
  if (readmeText) {
    guide.readmeQuickStart = extractReadmeQuickStart(readmeText.text)
  }

  return guide
})

function detectPackageManager(pkg: { packageManager?: string }): 'pnpm' | 'yarn' | 'npm' | 'bun' {
  if (pkg.packageManager?.startsWith('pnpm')) return 'pnpm'
  if (pkg.packageManager?.startsWith('yarn')) return 'yarn'
  if (pkg.packageManager?.startsWith('bun')) return 'bun'
  return 'npm'
}

function pmRunPrefix(pm: 'pnpm' | 'yarn' | 'npm' | 'bun'): string {
  return pm === 'npm' ? 'run' : pm === 'yarn' ? 'run' : pm === 'pnpm' ? '' : 'run'
}

function pickScript(scripts: Record<string, string>, candidates: string[]): string | null {
  for (const c of candidates) if (scripts[c]) return c
  return null
}

function extractMakeTargets(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/)
    if (m && m[1] && m[1] !== '.PHONY' && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/**
 * Pulls the first "## Install" / "## Quick start" / "## Getting started"
 * section out of the README and returns its body up to the next heading
 * or 800 chars, whichever comes first.
 */
function extractReadmeQuickStart(md: string): string | null {
  const headingRe = /^#{1,3}\s+(.+)$/gm
  const heads = [...md.matchAll(headingRe)]
  if (heads.length === 0) return null
  const wanted = /^(install|installation|quick.?start|getting.?started|setup|usage|development|running.?locally)/i
  const targetIdx = heads.findIndex((h) => wanted.test((h[1] ?? '').trim()))
  if (targetIdx < 0) return null
  const target = heads[targetIdx]
  if (!target || target.index === undefined) return null
  const next = heads[targetIdx + 1]
  const start = target.index + target[0].length
  const end = next?.index ?? Math.min(md.length, start + 800)
  return md.slice(start, end).trim().slice(0, 800)
}
