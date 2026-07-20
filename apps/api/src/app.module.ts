import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup'
import { GuestCookieMiddleware } from './common/middleware/guest-cookie.middleware'
import { AppConfigModule } from './modules/config/config.module'
import { AdminModule } from './modules/admin/admin.module'
import { AuditModule } from './modules/audit/audit.module'
import { AuthModule } from './modules/auth/auth.module'
import { BadgeModule } from './modules/badge/badge.module'
import { ChatModule } from './modules/chat/chat.module'
import { CostLogModule } from './modules/cost-log/cost-log.module'
import { QuotasModule } from './modules/quotas/quotas.module'
import { DrizzleModule } from './modules/drizzle/drizzle.module'
import { HealthModule } from './modules/health/health.module'
import { IndexerModule } from './modules/indexer/indexer.module'
import { KagModule } from './modules/kag/kag.module'
import { LoggerModule } from './modules/logger/logger.module'
import { McpModule } from './modules/mcp/mcp.module'
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
    QuotasModule,
    AuditModule,
    CostLogModule,
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
    McpModule,
    SeoRoutesModule,
    BadgeModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SentryGlobalFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(GuestCookieMiddleware)
      // README badges are anonymous by construction: the response is a
      // cacheable image with no per-visitor content, so minting a guest
      // id for it would attach an identity to something that carries
      // none — and put a Set-Cookie on a response shared caches (and
      // GitHub's camo proxy) are meant to reuse.
      .exclude({ path: 'badge/(.*)', method: RequestMethod.GET })
      .forRoutes('*')
  }
}
