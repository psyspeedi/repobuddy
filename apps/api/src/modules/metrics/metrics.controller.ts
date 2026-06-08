import { Controller, Get, Header } from '@nestjs/common'
import { register } from '#server/lib/metrics'

/**
 * Prometheus scrape endpoint. Re-uses the singleton Registry from
 * `#server/lib/metrics` so existing counter sites in KAG / indexer /
 * queues keep writing into the same registry that this endpoint
 * exposes — no metric was lost in the move.
 *
 * The queue-depth gauge refresh that previously ran on each scrape
 * will be re-introduced in step 7 once @nestjs/bullmq is wired.
 */
@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    return register.metrics()
  }
}
