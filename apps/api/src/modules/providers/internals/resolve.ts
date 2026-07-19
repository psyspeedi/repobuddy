/**
 * Resolve LLM + embeddings providers for a given user. When the user has
 * BYOK credentials saved (encryptedByokApiKey not null) and they decrypt
 * cleanly, use those — both for chat and embeddings, since BYOK is a
 * single-endpoint setup. Otherwise fall through to the server defaults
 * configured via env.
 *
 * The boolean `usesByok` is returned so callers can skip token-quota
 * enforcement on BYOK traffic (the user is paying their own bill).
 */
import type { Database } from '#server/db/client'
import { users, type User } from '#server/db/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '#server/lib/crypto'
import { loadEnv } from '#server/lib/env'
import { createLLMProvider, type LLMProvider } from './llm'
import { createEmbeddingsProvider, type EmbeddingsProvider } from './embeddings'
import { getLogger } from '#server/lib/logger'

const log = getLogger().child({ component: 'providers/resolve' })

export interface ResolvedProviders {
  llm: LLMProvider
  embeddings: EmbeddingsProvider
  usesByok: boolean
}

export interface ResolveOpts {
  llmModel?: string
  /**
   * Which server-default model family to use when no explicit model is
   * given: 'planning' (gpt-4o class — chat planning/answers) or
   * 'extraction' (gpt-4o-mini class — bulk annotation during indexing,
   * ~16x cheaper). BYOK users' own model choice always wins.
   */
  tier?: 'planning' | 'extraction'
}

export async function resolveProvidersForUser(
  db: Database,
  user: Pick<User, 'id' | 'byokBaseUrl' | 'byokModel' | 'byokEmbeddingModel' | 'encryptedByokApiKey'> | null,
  opts: ResolveOpts = {},
): Promise<ResolvedProviders> {
  const env = loadEnv()

  const serverModel =
    opts.llmModel ??
    (opts.tier === 'extraction'
      ? env.LLM_MODEL_EXTRACTION ?? env.OPENAI_MODEL_EXTRACTION
      : env.LLM_MODEL_PLANNING ?? env.OPENAI_MODEL_PLANNING)

  // Try BYOK first when the user row says it has one.
  if (user?.encryptedByokApiKey) {
    try {
      const apiKey = decrypt(user.encryptedByokApiKey, env.ENCRYPTION_KEY)
      const llm = createLLMProvider({
        apiKey,
        baseURL: user.byokBaseUrl ?? undefined,
        model: user.byokModel ?? serverModel,
      })
      const embeddings = createEmbeddingsProvider({
        apiKey,
        baseURL: user.byokBaseUrl ?? undefined,
        model: user.byokEmbeddingModel ?? env.EMBEDDING_MODEL ?? env.OPENAI_EMBEDDING_MODEL,
      })
      return { llm, embeddings, usesByok: true }
    } catch (err) {
      // BYOK record corrupted (key rotated etc) — surface a warning and
      // fall back to server creds so the user isn't locked out.
      log.warn(
        { userId: user.id, err: err instanceof Error ? err.message : String(err) },
        'BYOK decrypt failed; falling back to server defaults',
      )
    }
  }

  const llm = createLLMProvider({ model: serverModel })
  const embeddings = createEmbeddingsProvider({
    model: env.EMBEDDING_MODEL ?? env.OPENAI_EMBEDDING_MODEL,
  })
  return { llm, embeddings, usesByok: false }
}

/** Convenience: look up the user by id and resolve in one call. */
export async function resolveProvidersByUserId(
  db: Database,
  userId: string | null,
  opts: ResolveOpts = {},
): Promise<ResolvedProviders> {
  if (!userId) return resolveProvidersForUser(db, null, opts)
  const [row] = await db
    .select({
      id: users.id,
      byokBaseUrl: users.byokBaseUrl,
      byokModel: users.byokModel,
      byokEmbeddingModel: users.byokEmbeddingModel,
      encryptedByokApiKey: users.encryptedByokApiKey,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return resolveProvidersForUser(db, row ?? null, opts)
}
