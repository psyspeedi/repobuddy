import { Inject, Injectable } from '@nestjs/common'
import type { Job } from 'bullmq'
import { runIndexPipeline, type PipelineDeps } from '#server/indexer/pipeline'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'
import { ProviderResolverService } from '../providers/provider-resolver.service'

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
 */
@Injectable()
export class IndexerService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(ProviderResolverService) private readonly providers: ProviderResolverService,
  ) {}

  async run(job: Job<IndexJobData, IndexJobResult>): Promise<IndexJobResult> {
    const { userId } = job.data
    const { llm, embeddings } = await this.providers.resolveForUserId(userId)
    const deps: PipelineDeps = { llm, embeddings }
    return runIndexPipeline(this.db, job, deps)
  }
}
