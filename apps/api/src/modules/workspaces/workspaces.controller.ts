import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import type { Queue } from 'bullmq'
import type { Request } from 'express'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { users, workspaces } from '#server/db/schema'
import { CreateWorkspaceSchema } from '#shared/schemas/workspace'
import { recordAudit } from '#server/lib/audit'
import { assertCanCreateWorkspace, consumeWorkspace } from '#server/lib/quotas'
import { pingIndexNow } from '#server/lib/indexnow'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'
import { TypedConfigService } from '../config/typed-config.service'
import { INDEX_WORKSPACE_QUEUE } from '../queues/queue.constants'
import { WorkspaceAccessService } from './workspace-access.service'

const VisibilityBody = z.object({ isPublic: z.boolean() })
const OwnerKeyBody = z.object({ useOwnerKeyForGuests: z.boolean() })

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(TypedConfigService) private readonly config: TypedConfigService,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
    @InjectQueue(INDEX_WORKSPACE_QUEUE) private readonly indexQueue: Queue,
  ) {}

  /** GET /api/workspaces — list current user's workspaces */
  @Get()
  async list(@Req() req: Request) {
    const user = await this.access.requireValidUser(req)
    const rows = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerUserId, user.id))
      .orderBy(desc(workspaces.createdAt))
      .limit(100)
    return { workspaces: rows }
  }

  /** GET /api/workspaces/public — public list for landing page (no auth) */
  @Get('public')
  async listPublic() {
    const rows = await this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        sourceUrl: workspaces.sourceUrl,
        languages: workspaces.languages,
        stats: workspaces.stats,
        lastIndexedAt: workspaces.lastIndexedAt,
        ownerLogin: users.githubLogin,
      })
      .from(workspaces)
      .leftJoin(users, eq(users.id, workspaces.ownerUserId))
      .where(and(eq(workspaces.isPublic, true), eq(workspaces.status, 'ready')))
      .orderBy(desc(workspaces.lastIndexedAt))
      .limit(50)
    return { workspaces: rows }
  }

  /** POST /api/workspaces — create and enqueue index job */
  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    const user = await this.access.requireValidUser(req)
    const isAdmin = this.config.all().ADMIN_LOGINS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .includes(user.githubLogin.toLowerCase())
    await assertCanCreateWorkspace({ kind: 'user', id: user.id, bypass: isAdmin })

    const parsed = CreateWorkspaceSchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({ message: 'Invalid workspace payload', issues: parsed.error.issues })
    }
    const { source, name } = parsed.data
    const computedName =
      name ??
      (source.type === 'github'
        ? deriveNameFromUrl(source.url)
        : source.filename.replace(/\.zip$/i, ''))

    const [created] = await this.db
      .insert(workspaces)
      .values({
        ownerUserId: user.id,
        name: computedName,
        sourceType: source.type,
        sourceUrl: source.type === 'github' ? source.url : null,
        status: 'pending',
        progress: {
          phase: 'pending',
          percent: 0,
          message: 'Queued for indexing',
          updatedAt: new Date().toISOString(),
        },
      })
      .returning()
    if (!created) throw new Error('workspace insert failed')

    const job = await this.indexQueue.add(
      'index',
      { workspaceId: created.id, userId: user.id },
      { jobId: created.id },
    )
    await consumeWorkspace({ kind: 'user', id: user.id, bypass: isAdmin })
    await recordAudit(this.db, {
      userId: user.id,
      actorLogin: user.githubLogin,
      action: 'workspace.create',
      targetType: 'workspace',
      targetId: created.id,
      metadata: { name: created.name, sourceType: created.sourceType, sourceUrl: created.sourceUrl },
      ip: req.ip ?? null,
    })
    return { workspace: created, jobId: job.id }
  }

  /** GET /api/workspaces/:id */
  @Get(':id')
  async getOne(@Req() req: Request, @Param('id') id: string) {
    const { workspace, viewerIsOwner } = await this.access.read(req, id)
    return { workspace, viewerIsOwner }
  }

  /** DELETE /api/workspaces/:id */
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    const user = await this.access.requireValidUser(req)
    const isAdmin = this.config.all().ADMIN_LOGINS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .includes(user.githubLogin.toLowerCase())
    const whereClause = isAdmin
      ? eq(workspaces.id, id)
      : and(eq(workspaces.id, id), eq(workspaces.ownerUserId, user.id))

    const deleted = await this.db
      .delete(workspaces)
      .where(whereClause)
      .returning({ id: workspaces.id })
    if (deleted.length === 0) throw new NotFoundException('workspace not found')

    await recordAudit(this.db, {
      userId: user.id,
      actorLogin: user.githubLogin,
      action: isAdmin ? 'admin.delete_workspace' : 'workspace.delete',
      targetType: 'workspace',
      targetId: id,
      ip: req.ip ?? null,
    })
    return { ok: true }
  }

  /** POST /api/workspaces/:id/reindex — owner only */
  @Post(':id/reindex')
  async reindex(@Req() req: Request, @Param('id') id: string) {
    const user = await this.access.requireValidUser(req)
    const [ws] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, id), eq(workspaces.ownerUserId, user.id)))
      .limit(1)
    if (!ws) throw new NotFoundException('workspace not found')
    if (
      ws.status === 'cloning' ||
      ws.status === 'parsing' ||
      ws.status === 'extracting' ||
      ws.status === 'embedding'
    ) {
      throw new ConflictException(`workspace is already indexing (status: ${ws.status})`)
    }
    await this.db
      .update(workspaces)
      .set({
        status: 'pending',
        progress: {
          phase: 'pending',
          percent: 0,
          message: 'Queued for re-indexing',
          updatedAt: new Date().toISOString(),
        },
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, id))

    try {
      await this.indexQueue.remove(id)
    } catch {
      /* ignore — job may not exist or already completed */
    }
    const job = await this.indexQueue.add(
      'index',
      { workspaceId: id, userId: user.id },
      { jobId: id },
    )
    return { ok: true, jobId: job.id }
  }

  /** PUT /api/workspaces/:id/visibility — owner/admin */
  @Put(':id/visibility')
  async setVisibility(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const parsed = VisibilityBody.parse(body)
    const access = await this.access.write(req, id)
    await this.db
      .update(workspaces)
      .set({ isPublic: parsed.isPublic })
      .where(eq(workspaces.id, id))
    const [u] = await this.db
      .select({ githubLogin: users.githubLogin })
      .from(users)
      .where(eq(users.id, access.userId))
      .limit(1)
    await recordAudit(this.db, {
      userId: access.userId,
      actorLogin: u?.githubLogin ?? null,
      action: access.isAdmin ? 'admin.toggle_visibility' : 'workspace.visibility',
      targetType: 'workspace',
      targetId: id,
      metadata: { isPublic: parsed.isPublic },
      ip: req.ip ?? null,
    })
    const appUrl = (this.config.get('APP_URL') ?? '').replace(/\/$/, '')
    if (appUrl) {
      void pingIndexNow([`${appUrl}/w/${id}`, `${appUrl}/sitemap.xml`])
    }
    return { ok: true, isPublic: parsed.isPublic }
  }

  /**
   * PUT /api/workspaces/:id/owner-key — owner/admin. Opt in to paying for
   * visitors' chats with the owner's own BYOK key. Enabling requires the
   * owner to have a BYOK key set (chat resolution falls back to the server
   * key if it's ever missing, but we refuse to enable a toggle that would
   * silently do nothing).
   */
  @Put(':id/owner-key')
  async setOwnerKeyForGuests(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const parsed = OwnerKeyBody.parse(body)
    const access = await this.access.write(req, id)

    if (parsed.useOwnerKeyForGuests) {
      const [ws] = await this.db
        .select({ ownerUserId: workspaces.ownerUserId })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1)
      if (!ws) throw new NotFoundException('workspace not found')
      const [owner] = await this.db
        .select({ encryptedByokApiKey: users.encryptedByokApiKey })
        .from(users)
        .where(eq(users.id, ws.ownerUserId))
        .limit(1)
      if (!owner?.encryptedByokApiKey) {
        throw new BadRequestException(
          'Set a BYOK API key in Settings first — visitor chats can only run on a key the owner has provided.',
        )
      }
    }

    await this.db
      .update(workspaces)
      .set({ useOwnerKeyForGuests: parsed.useOwnerKeyForGuests })
      .where(eq(workspaces.id, id))
    const [u] = await this.db
      .select({ githubLogin: users.githubLogin })
      .from(users)
      .where(eq(users.id, access.userId))
      .limit(1)
    await recordAudit(this.db, {
      userId: access.userId,
      actorLogin: u?.githubLogin ?? null,
      action: 'workspace.owner_key_for_guests',
      targetType: 'workspace',
      targetId: id,
      metadata: { useOwnerKeyForGuests: parsed.useOwnerKeyForGuests },
      ip: req.ip ?? null,
    })
    return { ok: true, useOwnerKeyForGuests: parsed.useOwnerKeyForGuests }
  }
}

function deriveNameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length >= 2) return `${parts[0]}/${parts[1]?.replace(/\.git$/, '')}`
    return u.pathname || 'workspace'
  } catch {
    return 'workspace'
  }
}
