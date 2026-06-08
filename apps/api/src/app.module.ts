import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup'
import { GuestCookieMiddleware } from './common/middleware/guest-cookie.middleware'
import { AppConfigModule } from './modules/config/config.module'
import { AuthModule } from './modules/auth/auth.module'
import { DrizzleModule } from './modules/drizzle/drizzle.module'
import { HealthModule } from './modules/health/health.module'
import { KagModule } from './modules/kag/kag.module'
import { LoggerModule } from './modules/logger/logger.module'
import { MetricsModule } from './modules/metrics/metrics.module'
import { ProvidersModule } from './modules/providers/providers.module'
import { RedisModule } from './modules/redis/redis.module'

@Module({
  imports: [
    SentryModule.forRoot(),
    AppConfigModule,
    LoggerModule,
    RedisModule,
    DrizzleModule,
    ProvidersModule,
    KagModule,
    MetricsModule,
    HealthModule,
    AuthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SentryGlobalFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(GuestCookieMiddleware).forRoutes('*')
  }
}
