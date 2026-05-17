#!/usr/bin/env tsx
/**
 * Back-fill workspaces.stats.gitInsights for already-indexed workspaces.
 *
 * Why this exists: before fix dbeacd0, markWorkspaceReady overwrote
 * workspaces.stats and dropped the gitInsights written earlier in the
 * pipeline, so existing 'ready' workspaces never got their cards. This
 * script re-walks each repo's git history (cheap — seconds per repo)
 * and merges insights into stats without doing a full re-index.
 *
 * Usage:
 *   pnpm backfill:insights              # back-fill ALL ready workspaces missing insights
 *   pnpm backfill:insights --force      # re-compute even when insights already present
 *   pnpm backfill:insights <ws-uuid>    # one specific workspace
 */
import 'dotenv/config'
import { sql } from 'drizzle-orm'
import { closeDb, getDb } from '../server/db/client'
import { workspaces } from '../server/db/schema'
import { extractGitHistory } from '../server/indexer/git/history'
import { computeGitInsights } from '../server/indexer/git/insights'
import { fetchGitHub } from '../server/indexer/source/fetch'

interface CliArgs {
  force: boolean
  onlyId: string | null
}

function parseArgs(argv: string[]): CliArgs {
  let force = false
  let onlyId: string | null = null
  for (const a of argv.slice(2)) {
    if (a === '--force' || a === '-f') force = true
    else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`)
      process.exit(2)
    } else if (/^[0-9a-f-]{36}$/i.test(a)) {
      onlyId = a
    } else {
      console.error(`unrecognised arg: ${a}`)
      process.exit(2)
    }
  }
  return { force, onlyId }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set — check .env')
    process.exit(1)
  }
  const db = getDb(databaseUrl)

  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      sourceType: workspaces.sourceType,
      sourceUrl: workspaces.sourceUrl,
      status: workspaces.status,
      stats: workspaces.stats,
    })
    .from(workspaces)

  const candidates = rows.filter((ws) => {
    if (args.onlyId && ws.id !== args.onlyId) return false
    if (ws.status !== 'ready') return false
    if (ws.sourceType !== 'github' || !ws.sourceUrl) return false
    if (!args.force) {
      const existing = (ws.stats as { gitInsights?: unknown } | null)?.gitInsights
      if (existing) return false
    }
    return true
  })

  if (candidates.length === 0) {
    console.log('Nothing to do — no eligible workspaces found.')
    await closeDb()
    return
  }

  console.log(`Processing ${candidates.length} workspace(s)…`)
  let ok = 0
  let failed = 0
  for (const ws of candidates) {
    process.stdout.write(`  · ${ws.id}  ${ws.name} … `)
    let source: { workdir: string; cleanup: () => Promise<void> } | null = null
    try {
      source = await fetchGitHub(ws.sourceUrl as string)
      const history = await extractGitHistory(source.workdir)
      const insights = computeGitInsights(history)
      await db
        .update(workspaces)
        .set({
          stats: sql`coalesce(${workspaces.stats}, '{}'::jsonb) || ${JSON.stringify({ gitInsights: insights })}::jsonb`,
        })
        .where(sql`${workspaces.id} = ${ws.id}`)
      console.log(
        `ok (${insights.totalCommitsScanned} commits, ${insights.activeMaintainers90d} active maintainers)`,
      )
      ok++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`FAILED — ${msg}`)
      failed++
    } finally {
      if (source) await source.cleanup().catch(() => undefined)
    }
  }

  console.log(`\nDone. ${ok} updated, ${failed} failed.`)
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  void closeDb()
  process.exit(1)
})
