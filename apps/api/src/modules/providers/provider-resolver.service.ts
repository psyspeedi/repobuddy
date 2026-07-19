import { Inject, Injectable } from '@nestjs/common'
import { resolveProvidersByUserId, resolveProvidersForUser, type ResolvedProviders } from '#server/providers/resolve'
import { createLLMProvider, type LLMProvider } from '#server/providers/llm'
import { createEmbeddingsProvider, type EmbeddingsProvider } from '#server/providers/embeddings'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'
import { TypedConfigService } from '../config/typed-config.service'
import type { User } from '#server/db/schema'

/**
 * Thin DI wrapper over the legacy provider-resolution functions. The
 * legacy module already handles BYOK-decryption + server-default
 * fallback; we expose it as an @Injectable so HTTP handlers and the
 * worker can ask "give me the LLM + embeddings this user pays for"
 * without threading db / config through manually.
 */
@Injectable()
export class ProviderResolverService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(TypedConfigService) private readonly config: TypedConfigService,
  ) {}

  /** Resolve by user id; falls back to server defaults when id is null. */
  async resolveForUserId(
    userId: string | null,
    opts: { llmModel?: string } = {},
  ): Promise<ResolvedProviders> {
    return resolveProvidersByUserId(this.db, userId, opts)
  }

  /** Resolve from a hydrated user row (skip the extra SELECT). */
  async resolveForUser(
    user: Pick<User, 'id' | 'byokBaseUrl' | 'byokModel' | 'byokEmbeddingModel' | 'encryptedByokApiKey'> | null,
    opts: { llmModel?: string } = {},
  ): Promise<ResolvedProviders> {
    return resolveProvidersForUser(this.db, user, opts)
  }

  /** Direct server-default LLM (no BYOK lookup). For indexer / digest paths. */
  serverLlm(opts: { llmModel?: string } = {}): LLMProvider {
    const env = this.config.all()
    return createLLMProvider({
      model: opts.llmModel ?? env.LLM_MODEL_PLANNING ?? env.OPENAI_MODEL_PLANNING,
    })
  }

  /** Direct server-default embeddings. */
  serverEmbeddings(): EmbeddingsProvider {
    const env = this.config.all()
    return createEmbeddingsProvider({
      model: env.EMBEDDING_MODEL ?? env.OPENAI_EMBEDDING_MODEL,
    })
  }
}
