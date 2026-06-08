import { Global, Module, type OnApplicationShutdown } from '@nestjs/common'
import { closeDb, getDb } from '#server/db/client'
import { AppConfigModule } from '../config/config.module'
import { TypedConfigService } from '../config/typed-config.service'
import { DRIZZLE_DB } from './drizzle.tokens'

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: DRIZZLE_DB,
      inject: [TypedConfigService],
      useFactory: (config: TypedConfigService) =>
        getDb(config.get('DATABASE_URL')),
    },
  ],
  exports: [DRIZZLE_DB],
})
export class DrizzleModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await closeDb()
  }
}
