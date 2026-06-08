import { Global, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { TypedConfigService } from './typed-config.service'

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Root .env lives in the monorepo root; cwd when started via pnpm
      // --filter @repobuddy/api is apps/api/, so step up twice.
      envFilePath: ['../../.env'],
      cache: true,
    }),
  ],
  providers: [TypedConfigService],
  exports: [TypedConfigService],
})
export class AppConfigModule {}
