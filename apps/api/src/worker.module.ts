import { Module } from '@nestjs/common'
import { AppConfigModule } from './modules/config/config.module'
import { DrizzleModule } from './modules/drizzle/drizzle.module'
import { IndexerModule } from './modules/indexer/indexer.module'
import { KagModule } from './modules/kag/kag.module'
import { LoggerModule } from './modules/logger/logger.module'
import { MetricsModule } from './modules/metrics/metrics.module'
import { ProvidersModule } from './modules/providers/providers.module'
import { QueuesModule } from './modules/queues/queues.module'
import { RedisModule } from './modules/redis/redis.module'
import { WorkersModule } from './modules/workers/workers.module'

/**
 * Standalone root for the BullMQ worker process. No HTTP, no Auth /
 * Health controllers — just everything needed to run indexer jobs and
 * the daily digest.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    RedisModule,
    DrizzleModule,
    ProvidersModule,
    KagModule,
    IndexerModule,
    MetricsModule,
    QueuesModule,
    WorkersModule,
  ],
})
export class WorkerRootModule {}
