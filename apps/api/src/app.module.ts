import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup'
import { AppConfigModule } from './modules/config/config.module'
import { DrizzleModule } from './modules/drizzle/drizzle.module'
import { HealthModule } from './modules/health/health.module'
import { LoggerModule } from './modules/logger/logger.module'
import { MetricsModule } from './modules/metrics/metrics.module'
import { RedisModule } from './modules/redis/redis.module'

@Module({
  imports: [
    SentryModule.forRoot(),
    AppConfigModule,
    LoggerModule,
    RedisModule,
    DrizzleModule,
    MetricsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SentryGlobalFilter }],
})
export class AppModule {}
