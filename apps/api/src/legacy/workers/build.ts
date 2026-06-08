#!/usr/bin/env tsx
/**
 * Build worker as a standalone esbuild bundle, separate from Nuxt's Nitro
 * output. This avoids the risk of Nuxt tree-shaking worker-only code and
 * keeps the worker startup time minimal (single .mjs, no Nitro overhead).
 *
 * Output: .worker/index.mjs
 */
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'

const OUT_DIR = '.worker'
const ENTRY = 'server/workers/index.ts'

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  await build({
    entryPoints: [ENTRY],
    outfile: `${OUT_DIR}/index.mjs`,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    bundle: true,
    sourcemap: true,
    minify: false,
    // Keep these as runtime deps — bundling them creates large outputs
    // and pino/bullmq use dynamic requires/workers.
    external: [
      'pino',
      'pino-pretty',
      'bullmq',
      'ioredis',
      'postgres',
      'drizzle-orm',
      'drizzle-orm/postgres-js',
      'ts-morph',
      'web-tree-sitter',
      'simple-git',
      '@octokit/rest',
      'openai',
    ],
    banner: {
      // Allow top-level await + import.meta in ESM build.
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
    },
    logLevel: 'info',
  })
  console.log(`[build:worker] wrote ${OUT_DIR}/index.mjs`)
}

main().catch((err) => {
  console.error('[build:worker] failed:', err)
  process.exit(1)
})
