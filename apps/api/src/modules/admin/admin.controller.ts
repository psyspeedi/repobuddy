import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { auditEvents, workspaces } from '#server/db/schema'
import { recordAudit } from '#server/lib/audit'
import { getTodaySpendUsd } from '#server/lib/cost-log'
import { AdminGuard } from '../../common/guards/admin.guard'
import { TypedConfigService } from '../config/typed-config.service'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'
import { WorkspaceAccessService } from '../workspaces/workspace-access.service'

const BulkDeleteBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) })

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(TypedConfigService) private readonly config: TypedConfigService,
    @Inject(WorkspaceAccessService) private readonly access: WorkspaceAccessService,
  ) {}

  @Get('users')
  async users() {
    const rows = await this.db.execute<{
      id: string
      github_login: string
      email: string | null
      avatar_url: string | null
      created_at: string
      workspace_count: number
      messages_30d: number
      has_byok: boolean
    }>(sql`
      SELECT
        u.id, u.github_login, u.email, u.avatar_url, u.created_at,
        (SELECT count(*)::int FROM workspaces w WHERE w.owner_user_id = u.id) AS workspace_count,
        (SELECT count(*)::int FROM chat_messages m
          JOIN chat_sessions s ON s.id = m.session_id
          WHERE s.user_id = u.id AND m.role = 'user'
          AND m.created_at > now() - interval '30 days') AS messages_30d,
        (u.encrypted_byok_api_key IS NOT NULL) AS has_byok
      FROM users u
      ORDER BY u.created_at DESC
      LIMIT 200
    `)
    return { users: [...rows] }
  }

  @Get('audit')
  async audit(@Query() q: Record<string, string>) {
    const action = typeof q.action === 'string' ? q.action : null
    const limit = Math.min(Number(q.limit ?? 200), 500)
    const conditions: Parameters<typeof and>[number][] = []
    if (action) conditions.push(eq(auditEvents.action, action))
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditEvents.at))
      .limit(limit)
    return { events: rows }
  }

  @Get('workspaces')
  async listWorkspaces() {
    const rows = await this.db.execute<{
      id: string
      name: string
      source_url: string | null
      owner_login: string | null
      status: string
      is_public: boolean
      last_indexed_at: string | null
      created_at: string
      cost_cents: number
    }>(sql`
      SELECT
        w.id, w.name, w.source_url, u.github_login AS owner_login,
        w.status, w.is_public, w.last_indexed_at, w.created_at,
        coalesce((SELECT sum(usd_cents)::int FROM llm_cost_log c WHERE c.workspace_id = w.id), 0) AS cost_cents
      FROM workspaces w
      LEFT JOIN users u ON u.id = w.owner_user_id
      ORDER BY w.created_at DESC
      LIMIT 500
    `)
    return { workspaces: [...rows] }
  }

  @Get('overview')
  async overview() {
    const [row] = await this.db.execute<{
      user_count: number
      workspace_count: number
      ready_count: number
      public_count: number
      active_30d: number
      cost_cents_today: number
      cost_cents_7d: number
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM users) AS user_count,
        (SELECT count(*)::int FROM workspaces) AS workspace_count,
        (SELECT count(*)::int FROM workspaces WHERE status='ready') AS ready_count,
        (SELECT count(*)::int FROM workspaces WHERE is_public=true) AS public_count,
        (SELECT count(DISTINCT user_id)::int FROM chat_sessions
          WHERE updated_at > now() - interval '30 days') AS active_30d,
        (SELECT coalesce(sum(usd_cents),0)::int FROM llm_cost_log
          WHERE created_at::date = current_date) AS cost_cents_today,
        (SELECT coalesce(sum(usd_cents),0)::int FROM llm_cost_log
          WHERE created_at > now() - interval '7 days') AS cost_cents_7d
    `)
    const liveSpend = await getTodaySpendUsd()
    return {
      counts: row ?? null,
      costToday: liveSpend,
      costCapUsd: this.config.get('COST_BUDGET_USD_PER_DAY'),
    }
  }

  @Get('interest')
  async interest() {
    const rows = await this.db.execute<{
      id: string
      kind: string
      message: string | null
      created_at: string
      github_login: string
      email: string | null
    }>(sql`
      SELECT i.id, i.kind, i.message, i.created_at, u.github_login, u.email
      FROM interest_pings i
      JOIN users u ON u.id = i.user_id
      ORDER BY i.created_at DESC
      LIMIT 500
    `)
    const [{ total = 0 } = {}] = await this.db.execute<{ total: number }>(sql`
      SELECT count(*)::int AS total FROM interest_pings
    `)
    return { pings: [...rows], total }
  }

  @Post('bulk-delete')
  async bulkDelete(@Req() req: Request, @Body() body: unknown) {
    const parsed = BulkDeleteBody.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({ message: 'Invalid payload', issues: parsed.error.issues })
    }
    const admin = await this.access.requireAdmin(req)
    const deleted = await this.db
      .delete(workspaces)
      .where(inArray(workspaces.id, parsed.data.ids))
      .returning({ id: workspaces.id, name: workspaces.name })
    for (const w of deleted) {
      await recordAudit(this.db, {
        userId: admin.id,
        actorLogin: admin.githubLogin,
        action: 'admin.delete_workspace',
        targetType: 'workspace',
        targetId: w.id,
        metadata: { name: w.name, bulk: true },
        ip: req.ip ?? null,
      })
    }
    return { ok: true, deletedCount: deleted.length }
  }
}
