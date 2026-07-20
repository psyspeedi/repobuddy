import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { AppConfigModule } from '../config/config.module'
import { TypedConfigService } from '../config/typed-config.service'
import { INDEX_WORKSPACE_QUEUE } from './queue.constants'

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [TypedConfigService],
      useFactory: (config: TypedConfigService) => {
        const url = new URL(config.get('REDIS_URL'))
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || '6379'),
            password: url.password || undefined,
            maxRetriesPerRequest: null,
          },
        }
      },
    }),
    BullModule.registerQueue({
      name: INDEX_WORKSPACE_QUEUE,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 100, age: 24 * 3600 },
        removeOnFail: { count: 100, age: 7 * 24 * 3600 },
      },
    }),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
