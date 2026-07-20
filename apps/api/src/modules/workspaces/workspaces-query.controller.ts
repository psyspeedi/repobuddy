import { BadRequestException, Controller, Get, Inject, Param, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { rateLimitTake } from '#server/lib/rate-limit'
import { WorkspaceAccessService } from './workspace-access.service'
import {
  GRAPH_DEFAULT_LIMIT,
  SEARCH_DEFAULT_LIMIT,
  WorkspacesQueryService,
} from './workspaces-query.service'

// Both routes below reach out to GitHub with the deployment-wide token,
// and both are readable anonymously on a public workspace. Throttle per
// IP so a scripted sweep over /sitemap.xml cannot drain the hourly
// budget shared with the indexer and the KAG operators.
const GITHUB_ROUTE_RATE_LIMIT = 60
const GITHUB_ROUTE_RATE_WINDOW_SEC = 60

@Controller('workspaces/:id')
export class WorkspacesQueryController {
  constructor(
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
    @Inject(WorkspacesQueryService) private readonly query: WorkspacesQueryService,
  ) {}

  private async takeGithubRouteSlot(req: Request, route: string): Promise<boolean> {
    const quota = await rateLimitTake(
      `cg:rl:${route}:ip:${req.ip ?? 'unknown'}`,
      GITHUB_ROUTE_RATE_LIMIT,
      GITHUB_ROUTE_RATE_WINDOW_SEC,
    )
    return quota.ok
  }

  @Get('search')
  async search(@Req() req: Request, @Param('id') id: string, @Query() q: Record<string, string | string[]>) {
    await this.access.read(req, id)
    const text = typeof q.q === 'string' ? q.q : ''
    const limit = Number(q.limit ?? SEARCH_DEFAULT_LIMIT)
    return this.query.searchEntities(id, text, limit)
  }

  @Get('chunk/:chunkId')
  async chunk(@Req() req: Request, @Param('id') id: string, @Param('chunkId') chunkId: string) {
    await this.access.read(req, id)
    return this.query.getChunkById(id, chunkId)
  }

  @Get('chunk-by-path')
  async chunkByPath(@Req() req: Request, @Param('id') id: string, @Query() q: Record<string, string>) {
    await this.access.read(req, id)
    const path = typeof q.path === 'string' ? q.path : null
    const excludeId = typeof q.excludeId === 'string' ? q.excludeId : null
    return this.query.getChunkByPath(id, path, excludeId)
  }

  @Get('entity/:entityId')
  async entity(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('entityId') entityId: string,
  ) {
    await this.access.read(req, id)
    return this.query.getEntityDetails(id, entityId)
  }

  @Get('entity/:entityId/neighbours')
  async neighbours(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('entityId') entityId: string,
    @Query() q: Record<string, string>,
  ) {
    await this.access.read(req, id)
    const depth = Number(q.depth ?? 1)
    const limit = Number(q.limit ?? 60)
    return this.query.getEntityNeighbours(id, entityId, depth, limit)
  }

  @Get('graph')
  async graph(@Req() req: Request, @Param('id') id: string, @Query() q: Record<string, string | string[]>) {
    await this.access.read(req, id)
    const limit = Number(q.limit ?? GRAPH_DEFAULT_LIMIT)
    const types = parseList(q.types)
    const languages = parseList(q.languages)
    const includeNeighbors = q.neighbors !== '0' && q.neighbors !== 'false'
    return this.query.getGraph(id, { limit, typeFilter: types, langFilter: languages, includeNeighbors })
  }

  @Get('freshness')
  async freshness(@Req() req: Request, @Param('id') id: string) {
    await this.access.read(req, id)
    // Throttled reads degrade the same way a GitHub failure does: the
    // badge just doesn't render. Never a 500, never a stale lie.
    if (!(await this.takeGithubRouteSlot(req, 'freshness'))) {
      return { indexedSha: null, headSha: null, behindBy: null, checkedAt: new Date().toISOString() }
    }
    return this.query.getFreshness(id)
  }

  @Get('onboarding')
  async onboarding(@Req() req: Request, @Param('id') id: string) {
    await this.access.read(req, id)
    return this.query.getOnboarding(id)
  }

  @Get('setup-guide')
  async setupGuide(@Req() req: Request, @Param('id') id: string) {
    await this.access.read(req, id)
    return this.query.buildSetupGuide(id)
  }

  @Get('github-issues')
  async githubIssues(@Req() req: Request, @Param('id') id: string) {
    await this.access.read(req, id)
    // `rate_limited` is already a reason the onboarding UI renders.
    if (!(await this.takeGithubRouteSlot(req, 'gh-issues'))) {
      return { issues: [], reason: 'rate_limited' }
    }
    return this.query.getFirstIssues(id)
  }

  @Get('treemap')
  async treemap(@Req() req: Request, @Param('id') id: string) {
    await this.access.read(req, id)
    return this.query.getTreemap(id)
  }
}

function parseList(value: unknown): string[] | undefined {
  if (!value) return undefined
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean)
  return undefined
}

// Keep the type-only import to ensure the file fails to load if BadRequestException ever stops being exported.
void BadRequestException
