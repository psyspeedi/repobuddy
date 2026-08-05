#!/usr/bin/env tsx
/**
 * Apply pending Drizzle migrations and run raw SQL migrations
 * (tsvector generated column + GIN index) that are not expressible
 * via the typed schema.
 */
import { config as loadDotenv } from 'dotenv'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// The .env lives at the monorepo root but pnpm runs this script with cwd
// = apps/api, so bare `dotenv/config` finds nothing. main.ts and
// config.module.ts already resolve it explicitly; this is the third.
loadDotenv({ path: resolve(process.cwd(), '../../.env') })

const DRIZZLE_DIR = process.env.DRIZZLE_DIR ?? '../../drizzle'
const RAW_SQL_DIR = join(process.cwd(), DRIZZLE_DIR, 'raw')

async function applyRawSqlMigrations(sql: postgres.Sql): Promise<void> {
  let files: string[]
  try {
    files = (await readdir(RAW_SQL_DIR)).filter((f) => f.endsWith('.sql')).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "_repobuddy_raw_migrations" (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `)

  for (const file of files) {
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM "_repobuddy_raw_migrations" WHERE name = ${file}
      ) AS exists
    `
    if (rows[0]?.exists) continue

    const content = await readFile(join(RAW_SQL_DIR, file), 'utf-8')
    console.log(`[migrate] applying raw SQL: ${file}`)
    await sql.unsafe(content)
    await sql`
      INSERT INTO "_repobuddy_raw_migrations" (name) VALUES (${file})
    `
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  const sql = postgres(databaseUrl, { max: 1 })
  const db = drizzle(sql)

  try {
    // The very first migration creates tables with `vector` columns, so
    // the extension has to exist before drizzle runs. docker/init-db.sql
    // creates these for the compose Postgres, but the documented manual
    // path is just `pnpm db:migrate` against any database — make it
    // self-sufficient. Idempotent, so it's a no-op when init-db already ran.
    console.log('[migrate] ensuring extensions…')
    await sql.unsafe(
      'CREATE EXTENSION IF NOT EXISTS vector;'
        + ' CREATE EXTENSION IF NOT EXISTS pg_trgm;'
        + ' CREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
    )
    console.log('[migrate] applying drizzle migrations…')
    await migrate(db, { migrationsFolder: DRIZZLE_DIR })
    console.log('[migrate] applying raw SQL migrations…')
    await applyRawSqlMigrations(sql)
    console.log('[migrate] done.')
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
