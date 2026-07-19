import { BadRequestException, Controller, Get, Inject, Param, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { WorkspaceAccessService } from './workspace-access.service'
import {
  GRAPH_DEFAULT_LIMIT,
  SEARCH_DEFAULT_LIMIT,
  WorkspacesQueryService,
} from './workspaces-query.service'

@Controller('workspaces/:id')
export class WorkspacesQueryController {
  constructor(
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
    @Inject(WorkspacesQueryService) private readonly query: WorkspacesQueryService,
  ) {}

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
