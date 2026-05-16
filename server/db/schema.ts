import { sql } from 'drizzle-orm'
import {
  bigint,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'

const EMBEDDING_DIMS = 1536

// tsvector custom type — Drizzle does not have a native binding.
// Storage stays in Postgres' tsvector; we treat it as opaque from the TS side.
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  },
})

// ---------- Users ----------
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    githubId: text('github_id').notNull(),
    githubLogin: text('github_login').notNull(),
    email: text('email'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique('users_github_id_unique').on(table.githubId)],
)

// ---------- OAuth tokens (encrypted at rest) ----------
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // 'github'
    encryptedAccessToken: text('encrypted_access_token').notNull(),
    encryptedRefreshToken: text('encrypted_refresh_token'),
    scope: text('scope'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('oauth_tokens_user_provider_unique').on(
      table.userId,
      table.provider,
    ),
  ],
)

// ---------- Workspaces ----------
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sourceType: text('source_type').notNull(), // 'github' | 'upload'
    sourceUrl: text('source_url'),
    defaultBranch: text('default_branch'),
    indexedCommitSha: text('indexed_commit_sha'),
    status: text('status').notNull().default('pending'),
    progress: jsonb('progress').notNull().default(sql`'{}'::jsonb`),
    stats: jsonb('stats').notNull().default(sql`'{}'::jsonb`),
    languages: text('languages').array().notNull().default(sql`'{}'::text[]`),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }),
  },
  (table) => [
    index('workspaces_owner_idx').on(table.ownerUserId),
    index('workspaces_status_idx').on(table.status),
  ],
)

// ---------- Entities (graph nodes) ----------
export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    name: text('name').notNull(),
    qualifiedName: text('qualified_name'),
    normalizedName: text('normalized_name').notNull(),
    language: text('language'),
    filePath: text('file_path'),
    startLine: integer('start_line'),
    endLine: integer('end_line'),
    signature: text('signature'),
    visibility: text('visibility'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    description: text('description'),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMS }),
    sourceChunkIds: uuid('source_chunk_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Workspace-level uniqueness for symbols that have a fully-qualified name.
    // NULL qualified_name (concepts/patterns/etc) skips this constraint.
    unique('entities_workspace_qualified_name_unique').on(
      table.workspaceId,
      table.qualifiedName,
    ),
    index('entities_workspace_type_name_idx').on(
      table.workspaceId,
      table.type,
      table.normalizedName,
    ),
    index('entities_workspace_file_idx').on(table.workspaceId, table.filePath),
    index('entities_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  ],
)

// ---------- Relations (graph edges) ----------
export const relations = pgTable(
  'relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fromEntityId: uuid('from_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    toEntityId: uuid('to_entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    evidenceQuote: text('evidence_quote'),
    sourceChunkId: uuid('source_chunk_id'),
    sourceCommitSha: text('source_commit_sha'),
    weight: real('weight').notNull().default(1.0),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('relations_workspace_from_type_idx').on(
      table.workspaceId,
      table.fromEntityId,
      table.type,
    ),
    index('relations_workspace_to_type_idx').on(
      table.workspaceId,
      table.toEntityId,
      table.type,
    ),
  ],
)

// ---------- Chunks ----------
// `text_tsv` is a GENERATED ALWAYS AS STORED column created via raw SQL migration
// (Drizzle does not support GENERATED columns natively for tsvector).
// We declare it here as a regular column so we can SELECT it; INSERTs must omit it.
export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    filePath: text('file_path'),
    startLine: integer('start_line'),
    endLine: integer('end_line'),
    text: text('text').notNull(),
    textTsv: tsvector('text_tsv'),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMS }),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('chunks_workspace_idx').on(table.workspaceId),
    index('chunks_workspace_file_idx').on(table.workspaceId, table.filePath),
    index('chunks_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
    // tsv GIN index is created in raw SQL migration alongside the generated column
  ],
)

// ---------- Entity ↔ Chunk mutual index ----------
export const entityChunks = pgTable(
  'entity_chunks',
  {
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.entityId, table.chunkId] }),
    index('entity_chunks_chunk_idx').on(table.chunkId),
  ],
)

// ---------- Chat ----------
export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New chat'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('chat_sessions_workspace_idx').on(table.workspaceId),
    index('chat_sessions_user_idx').on(table.userId),
  ],
)

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // 'user' | 'assistant'
    content: text('content').notNull(),
    plan: jsonb('plan'),
    trace: jsonb('trace'),
    tokensUsed: integer('tokens_used'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('chat_messages_session_idx').on(table.sessionId, table.createdAt),
  ],
)

// ---------- Query cache (raw question → answer) ----------
export const queryCache = pgTable(
  'query_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    questionHash: text('question_hash').notNull(),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    plan: jsonb('plan'),
    trace: jsonb('trace'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('query_cache_workspace_hash_unique').on(
      table.workspaceId,
      table.questionHash,
    ),
  ],
)

// ---------- Token / cost ledger (for LLM_BUDGET_USD_PER_INDEX guardrails) ----------
export const llmCostLog = pgTable(
  'llm_cost_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    phase: text('phase').notNull(), // 'indexing' | 'planning' | 'answering' | 'embedding'
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    usdCents: integer('usd_cents').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('llm_cost_log_workspace_phase_idx').on(
      table.workspaceId,
      table.phase,
    ),
  ],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert
export type Entity = typeof entities.$inferSelect
export type NewEntity = typeof entities.$inferInsert
export type Relation = typeof relations.$inferSelect
export type NewRelation = typeof relations.$inferInsert
export type Chunk = typeof chunks.$inferSelect
export type NewChunk = typeof chunks.$inferInsert
export type ChatSession = typeof chatSessions.$inferSelect
export type ChatMessage = typeof chatMessages.$inferSelect
