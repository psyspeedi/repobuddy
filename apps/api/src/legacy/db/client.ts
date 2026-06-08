import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

let _client: ReturnType<typeof postgres> | null = null
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDbClient(databaseUrl: string): postgres.Sql {
  if (!_client) {
    _client = postgres(databaseUrl, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
    })
  }
  return _client
}

export function getDb(
  databaseUrl: string,
): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) {
    _db = drizzle(getDbClient(databaseUrl), { schema, logger: false })
  }
  return _db
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end({ timeout: 5 })
    _client = null
    _db = null
  }
}

export type Database = ReturnType<typeof getDb>
export { schema }
