export const DRIZZLE_DB = Symbol.for('repobuddy:drizzle-db')
export type DrizzleDb = import('#server/db/client').Database
