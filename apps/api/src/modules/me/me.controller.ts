import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common'
import type { Request } from 'express'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { interestPings, users } from '#server/db/schema'
import { encrypt } from '#server/lib/crypto'
import { recordAudit } from '#server/lib/audit'
import { getStatus, type QuotaContext } from '#server/lib/quotas'
import { AuthService } from '../auth/auth.service'
import { TypedConfigService } from '../config/typed-config.service'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'
import { WorkspaceAccessService } from '../workspaces/workspace-access.service'

const BYOK_PUT = z.object({
  baseUrl: z.string().url().nullable().optional(),
  model: z.string().min(1).max(128).nullable().optional(),
  embeddingModel: z.string().min(1).max(128).nullable().optional(),
  apiKey: z.string().min(1).max(512).nullable().optional(),
})

const INTEREST_GET = z.object({ kind: z.string().min(1).max(64).default('more_limits') })
const INTEREST_POST = z.object({
  kind: z.string().min(1).max(64).default('more_limits'),
  message: z.string().trim().max(500).optional(),
})

@Controller('me')
export class MeController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(TypedConfigService) private readonly config: TypedConfigService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
  ) {}

  /** Lightweight admin probe. Always 200; caller branches on isAdmin. */
  @Get('admin')
  async admin(@Req() req: Request) {
    if (!req.isAuthenticated?.() || !req.user?.id) {
      return { isAdmin: false, reason: 'unauthenticated' }
    }
    const [u] = await this.db
      .select({ githubLogin: users.githubLogin })
      .from(users)
      .where(eq(users.id, req.user.id))
      .limit(1)
    if (!u) return { isAdmin: false, reason: 'user not found' }
    return { isAdmin: this.auth.isAdmin(u.githubLogin), login: u.githubLogin }
  }

  @Get('quota')
  async quota(@Req() req: Request) {
    let ctx: QuotaContext
    let kind: 'user' | 'guest' | 'admin' = 'guest'
    const uid = req.user?.id
    if (uid) {
      const [u] = await this.db
        .select({
          id: users.id,
          githubLogin: users.githubLogin,
          encryptedByokApiKey: users.encryptedByokApiKey,
        })
        .from(users)
        .where(eq(users.id, uid))
        .limit(1)
      if (u) {
        const admin = this.auth.isAdmin(u.githubLogin)
        ctx = { kind: 'user', id: u.id, bypass: admin || Boolean(u.encryptedByokApiKey) }
        kind = admin ? 'admin' : 'user'
      } else {
        ctx = { kind: 'guest', id: req.guestId ?? 'unknown' }
      }
    } else {
      ctx = { kind: 'guest', id: req.guestId ?? 'unknown' }
    }
    const status = await getStatus(ctx)
    return { ...status, viewerKind: kind }
  }

  @Get('byok')
  async byokGet(@Req() req: Request) {
    const user = await this.access.requireValidUser(req)
    const [row] = await this.db
      .select({
        byokBaseUrl: users.byokBaseUrl,
        byokModel: users.byokModel,
        byokEmbeddingModel: users.byokEmbeddingModel,
        encryptedByokApiKey: users.encryptedByokApiKey,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
    return {
      configured: Boolean(row?.encryptedByokApiKey),
      baseUrl: row?.byokBaseUrl ?? null,
      model: row?.byokModel ?? null,
      embeddingModel: row?.byokEmbeddingModel ?? null,
    }
  }

  @Put('byok')
  async byokPut(@Req() req: Request, @Body() body: unknown) {
    const user = await this.access.requireValidUser(req)
    const parsed = BYOK_PUT.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({ message: 'Invalid BYOK payload', issues: parsed.error.issues })
    }
    const update: Record<string, string | null> = {}
    if (parsed.data.baseUrl !== undefined) update.byokBaseUrl = parsed.data.baseUrl
    if (parsed.data.model !== undefined) update.byokModel = parsed.data.model
    if (parsed.data.embeddingModel !== undefined) update.byokEmbeddingModel = parsed.data.embeddingModel
    if (parsed.data.apiKey !== undefined) {
      update.encryptedByokApiKey = parsed.data.apiKey
        ? encrypt(parsed.data.apiKey, this.config.get('ENCRYPTION_KEY'))
        : null
    }
    if (Object.keys(update).length === 0) return { ok: true, changed: false }
    await this.db.update(users).set(update).where(eq(users.id, user.id))
    if (parsed.data.apiKey !== undefined) {
      await recordAudit(this.db, {
        userId: user.id,
        actorLogin: user.githubLogin,
        action: parsed.data.apiKey ? 'byok.set' : 'byok.clear',
        targetType: 'user',
        targetId: user.id,
        ip: req.ip ?? null,
      })
    }
    return { ok: true, changed: true }
  }

  @Get('interest')
  async interestGet(@Req() req: Request, @Query() q: Record<string, string>) {
    const user = await this.access.requireValidUser(req)
    const { kind } = INTEREST_GET.parse(q)
    const [row] = await this.db
      .select()
      .from(interestPings)
      .where(and(eq(interestPings.userId, user.id), eq(interestPings.kind, kind)))
      .limit(1)
    return { sent: Boolean(row), sentAt: row?.createdAt ?? null }
  }

  @Post('interest')
  async interestPost(@Req() req: Request, @Body() body: unknown) {
    const user = await this.access.requireValidUser(req)
    const parsed = INTEREST_POST.safeParse(body)
    if (!parsed.success) throw new BadRequestException({ issues: parsed.error.issues })
    const existing = await this.db
      .select()
      .from(interestPings)
      .where(and(eq(interestPings.userId, user.id), eq(interestPings.kind, parsed.data.kind)))
      .limit(1)
    if (existing[0]) return { ok: true, alreadySent: true }
    await this.db
      .insert(interestPings)
      .values({ userId: user.id, kind: parsed.data.kind, message: parsed.data.message || null })
      .onConflictDoNothing()
    return { ok: true, alreadySent: false }
  }
}
