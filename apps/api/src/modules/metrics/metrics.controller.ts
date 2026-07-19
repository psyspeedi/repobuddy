import { Controller, Get, Header, NotFoundException, Req, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'
import { register } from '#server/lib/metrics'
import { loadEnv } from '#server/lib/env'

/**
 * Prometheus scrape endpoint. Re-uses the singleton Registry from
 * `#server/lib/metrics` so existing counter sites in KAG / indexer /
 * queues keep writing into the same registry that this endpoint
 * exposes — no metric was lost in the move.
 *
 * Access control: metrics leak usage/cost details, so in production the
 * endpoint requires `Authorization: Bearer $METRICS_TOKEN`. When the
 * token isn't configured, production returns 404 (robots.txt is not a
 * fence); dev/test stay open for the local Prometheus container.
 */
@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(@Req() req: Request): Promise<string> {
    const env = loadEnv()
    if (env.METRICS_TOKEN) {
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${env.METRICS_TOKEN}`) {
        throw new UnauthorizedException()
      }
    } else if (env.NODE_ENV === 'production') {
      throw new NotFoundException()
    }
    return register.metrics()
  }
}
