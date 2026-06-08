import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import type { Job } from 'bullmq'
import { IndexerService } from '../indexer/indexer.service'
import { INDEX_WORKSPACE_QUEUE } from '../queues/queue.constants'

interface JobData {
  workspaceId: string
  userId: string | null
}

interface JobResult {
  ok: boolean
  filesProcessed?: number
  durationMs?: number
}

@Processor(INDEX_WORKSPACE_QUEUE, {
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
})
export class IndexWorkspaceProcessor extends WorkerHost {
  private readonly log = new Logger(IndexWorkspaceProcessor.name)

  constructor(@Inject(IndexerService) private readonly indexer: IndexerService) {
    super()
  }

  async process(job: Job<JobData, JobResult>): Promise<JobResult> {
    this.log.log(`pickup job ${job.id} workspace=${job.data.workspaceId}`)
    return this.indexer.run(job)
  }
}
