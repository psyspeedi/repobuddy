import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup'
import { GuestCookieMiddleware } from './common/middleware/guest-cookie.middleware'
import { AppConfigModule } from './modules/config/config.module'
import { AdminModule } from './modules/admin/admin.module'
import { AuthModule } from './modules/auth/auth.module'
import { ChatModule } from './modules/chat/chat.module'
import { DrizzleModule } from './modules/drizzle/drizzle.module'
import { HealthModule } from './modules/health/health.module'
import { IndexerModule } from './modules/indexer/indexer.module'
import { KagModule } from './modules/kag/kag.module'
import { LoggerModule } from './modules/logger/logger.module'
import { MeModule } from './modules/me/me.module'
import { MetricsModule } from './modules/metrics/metrics.module'
import { ProvidersModule } from './modules/providers/providers.module'
import { QueuesModule } from './modules/queues/queues.module'
import { RedisModule } from './modules/redis/redis.module'
import { SeoRoutesModule } from './modules/seo-routes/seo-routes.module'
import { WorkspacesModule } from './modules/workspaces/workspaces.module'

@Module({
  imports: [
    SentryModule.forRoot(),
    AppConfigModule,
    LoggerModule,
    RedisModule,
    DrizzleModule,
    ProvidersModule,
    KagModule,
    IndexerModule,
    QueuesModule,
    MetricsModule,
    HealthModule,
    AuthModule,
    WorkspacesModule,
    ChatModule,
    AdminModule,
    MeModule,
    SeoRoutesModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SentryGlobalFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(GuestCookieMiddleware).forRoutes('*')
  }
}
