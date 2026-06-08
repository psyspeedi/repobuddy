import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common'
import { Redis } from 'ioredis'
import { AppConfigModule } from '../config/config.module'
import { TypedConfigService } from '../config/typed-config.service'
import { REDIS_CLIENT, type RedisClient } from './redis.tokens'

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [TypedConfigService],
      useFactory: (config: TypedConfigService): RedisClient => {
        // maxRetriesPerRequest: null — required so the same connection
        // can later back BullMQ producers/consumers without crashing on
        // long-running blocking commands.
        return new Redis(config.get('REDIS_URL'), {
          maxRetriesPerRequest: null,
        })
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}
  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit()
  }
}
