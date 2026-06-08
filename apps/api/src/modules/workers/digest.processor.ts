import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import type { Job, Queue } from 'bullmq'
import { runDailyDigest } from './internals/digest'
import { DIGEST_CRON_UTC, DIGEST_QUEUE } from '../queues/queue.constants'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'

interface JobData {
  day: string
}

@Processor(DIGEST_QUEUE)
export class DigestProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly log = new Logger(DigestProcessor.name)

  constructor(
    @InjectQueue(DIGEST_QUEUE) private readonly queue: Queue<JobData>,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
  ) {
    super()
  }

  /** Idempotent — BullMQ dedups by repeat-key. */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.add(
      'daily-digest',
      { day: new Date().toISOString().slice(0, 10) },
      { repeat: { pattern: DIGEST_CRON_UTC, tz: 'UTC' } },
    )
    this.log.log(`scheduled daily digest cron=${DIGEST_CRON_UTC} tz=UTC`)
  }

  async process(_job: Job<JobData>): Promise<void> {
    await runDailyDigest(this.db)
  }
}
