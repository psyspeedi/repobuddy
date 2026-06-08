#!/usr/bin/env tsx
/**
 * Backfill llm_cost_log for workspaces indexed before the cost ledger
 * was wired. Approximates spend from what's already in the DB:
 *   - annotation: entities with non-null description × prompt+output token estimate.
 *   - embedding:  chunks with non-null embedding × text.length/4 token estimate.
 * Chat answer spend is NOT backfilled — that data is lost.
 *
 * Idempotent: rows tagged with model="backfill:<phase>" so re-runs skip
 * workspaces that already carry a backfill marker for the same phase.
 *
 * Usage:
 *   pnpm backfill:cost                  # all ready workspaces missing backfill
 *   pnpm backfill:cost --force          # re-compute even where backfill rows exist
 *   pnpm backfill:cost <ws-uuid>        # one workspace
 */
import 'dotenv/config'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { closeDb, getDb } from '#server/db/client'
import {
  chunks as chunksTable,
  entities as entitiesTable,
  llmCostLog,
  workspaces,
} from '#server/db/schema'

// Approximate retail pricing (cents per 1M tokens) for the OpenAI
// model families our pipeline historically used. Non-OpenAI providers
// pay less; treat as an upper bound.
const ANNOTATION_INPUT_PER_1M = 15   // gpt-4o-mini in
const ANNOTATION_OUTPUT_PER_1M = 60  // gpt-4o-mini out
const EMBEDDING_PER_1M = 2           // text-embedding-3-small

const APPROX_ANNOTATION_INPUT = 800  // tokens — prompt + truncated code
const APPROX_ANNOTATION_OUTPUT = 200 // schema-bounded JSON response

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
      status: workspaces.status,
    })
    .from(workspaces)

  const eligible = rows.filter((ws) => {
    if (args.onlyId && ws.id !== args.onlyId) return false
    if (ws.status !== 'ready') return false
    return true
  })

  if (eligible.length === 0) {
    console.log('Nothing to do — no eligible workspaces.')
    await closeDb()
    return
  }

  console.log(`Processing ${eligible.length} workspace(s)…`)
  let totalCents = 0
  for (const ws of eligible) {
    process.stdout.write(`  · ${ws.id}  ${ws.name} … `)
    try {
      // Skip if we've already backfilled this workspace (unless --force).
      if (!args.force) {
        const [marker] = await db
          .select({ id: llmCostLog.id })
          .from(llmCostLog)
          .where(
            and(
              eq(llmCostLog.workspaceId, ws.id),
              sql`${llmCostLog.model} LIKE 'backfill:%'`,
            ),
          )
          .limit(1)
        if (marker) {
          console.log('skip (already backfilled)')
          continue
        }
      }

      const [annotated] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(entitiesTable)
        .where(
          and(
            eq(entitiesTable.workspaceId, ws.id),
            isNotNull(entitiesTable.description),
          ),
        )

      const [embedded] = await db
        .select({
          n: sql<number>`count(*)::int`,
          chars: sql<number>`coalesce(sum(char_length(text)),0)::bigint`,
        })
        .from(chunksTable)
        .where(
          and(
            eq(chunksTable.workspaceId, ws.id),
            isNotNull(chunksTable.embedding),
          ),
        )

      const annN = annotated?.n ?? 0
      const embN = embedded?.n ?? 0
      const embTokens = Math.ceil(Number(embedded?.chars ?? 0) / 4)

      const annInTok = annN * APPROX_ANNOTATION_INPUT
      const annOutTok = annN * APPROX_ANNOTATION_OUTPUT
      const annCents =
        Math.ceil((annInTok * ANNOTATION_INPUT_PER_1M) / 1_000_000) +
        Math.ceil((annOutTok * ANNOTATION_OUTPUT_PER_1M) / 1_000_000)
      const embCents = Math.ceil((embTokens * EMBEDDING_PER_1M) / 1_000_000)

      const inserts: { phase: 'annotation' | 'embedding'; model: string; inputTokens: number; outputTokens: number; usdCents: number }[] = []
      if (annN > 0) {
        inserts.push({
          phase: 'annotation',
          model: 'backfill:annotation',
          inputTokens: annInTok,
          outputTokens: annOutTok,
          usdCents: annCents,
        })
      }
      if (embN > 0) {
        inserts.push({
          phase: 'embedding',
          model: 'backfill:embedding',
          inputTokens: embTokens,
          outputTokens: 0,
          usdCents: embCents,
        })
      }
      for (const row of inserts) {
        await db.insert(llmCostLog).values({ workspaceId: ws.id, ...row })
      }
      const cents = annCents + embCents
      totalCents += cents
      console.log(
        `ok (annotated=${annN}, embedded=${embN}, ~$${(cents / 100).toFixed(2)})`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`FAILED — ${msg}`)
    }
  }

  console.log(`\nDone. Estimated backfilled spend: $${(totalCents / 100).toFixed(2)}.`)
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  void closeDb()
  process.exit(1)
})
