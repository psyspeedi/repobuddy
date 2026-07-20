import { Inject, Injectable } from '@nestjs/common'
import type { Job } from 'bullmq'
import { eq } from 'drizzle-orm'
import { runIndexPipeline, type PipelineDeps } from '#server/indexer/pipeline'
import { users } from '#server/db/schema'
import { assertWithinDailyBudget } from '#server/lib/cost-log'
import { isAdminLogin } from '#server/lib/admin'
import { markWorkspaceFailed } from '#modules/workspaces/workspace-progress'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'
import { ProviderResolverService } from '../providers/provider-resolver.service'
import { TypedConfigService } from '../config/typed-config.service'

interface IndexJobData {
  workspaceId: string
  userId: string | null
}

interface IndexJobResult {
  ok: boolean
  filesProcessed?: number
  durationMs?: number
}

/**
 * Thin DI wrapper around #server/indexer/pipeline.runIndexPipeline.
 * Looks up per-user providers (BYOK or server defaults) before
 * delegating; that lets the BullMQ processor in the worker call
 * `indexer.run(job)` without re-implementing the resolution dance.
 *
 * Cost controls applied here (not in the pipeline, so tests stay free
 * of env coupling):
 * - annotation runs on the cheap extraction tier (gpt-4o-mini class),
 *   not the planning model;
 * - server-paid runs are gated on the service-wide daily budget and
 *   hard-capped per index via LLM_BUDGET_USD_PER_INDEX;
 * - MAX_FILES_PER_INDEX / MAX_REPO_SIZE_MB are forwarded to the walk
 *   and clone steps. BYOK users pay their own bill and skip the gates.
 */
@Injectable()
export class IndexerService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(ProviderResolverService) private readonly providers: ProviderResolverService,
    @Inject(TypedConfigService) private readonly config: TypedConfigService,
  ) {}

  async run(job: Job<IndexJobData, IndexJobResult>): Promise<IndexJobResult> {
    const { workspaceId, userId } = job.data
    const env = this.config.all()
    const { llm, embeddings, usesByok } = await this.providers.resolveForUserId(
      userId,
      { tier: 'extraction' },
    )

    if (!usesByok) {
      let login: string | null = null
      if (userId) {
        const [row] = await this.db
          .select({ login: users.githubLogin })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1)
        login = row?.login ?? null
      }
      try {
        await assertWithinDailyBudget({ bypass: isAdminLogin(login) })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await markWorkspaceFailed(this.db, workspaceId, msg)
        return { ok: false }
      }
    }

    const deps: PipelineDeps = {
      llm,
      embeddings,
      maxFiles: env.MAX_FILES_PER_INDEX,
      maxRepoSizeMb: env.MAX_REPO_SIZE_MB,
      annotationBudgetUsd: usesByok ? undefined : env.LLM_BUDGET_USD_PER_INDEX,
      usesByok,
    }
    return runIndexPipeline(this.db, job, deps)
  }
}
