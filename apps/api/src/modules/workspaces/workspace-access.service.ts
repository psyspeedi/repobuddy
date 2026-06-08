import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import type { Request } from 'express'
import { users, workspaces, type Workspace } from '#server/db/schema'
import { AuthService } from '../auth/auth.service'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'

export interface ReadAccessResult {
  workspace: Workspace
  viewer:
    | { kind: 'owner'; userId: string }
    | { kind: 'admin'; userId: string }
    | { kind: 'guest'; guestId: string }
  viewerIsOwner: boolean
}

export interface WriteAccessResult {
  workspace: Workspace
  userId: string
  isAdmin: boolean
}

/**
 * NestJS-flavoured port of #server/lib/workspace-access. Reads session
 * + guest cookie from the Express request; bumps `req.guestId` via the
 * GuestCookieMiddleware so we don't have to set the cookie here.
 */
@Injectable()
export class WorkspaceAccessService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async read(req: Request, workspaceId: string): Promise<ReadAccessResult> {
    if (!workspaceId) throw new BadRequestException('workspaceId required')

    const [ws] = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    if (!ws) throw new NotFoundException('workspace not found')

    const sessionUserId = req.user?.id
    if (sessionUserId) {
      const [u] = await this.db
        .select({ id: users.id, githubLogin: users.githubLogin })
        .from(users)
        .where(eq(users.id, sessionUserId))
        .limit(1)
      if (u) {
        if (u.id === ws.ownerUserId) {
          return { workspace: ws, viewer: { kind: 'owner', userId: u.id }, viewerIsOwner: true }
        }
        if (this.auth.isAdmin(u.githubLogin)) {
          return { workspace: ws, viewer: { kind: 'admin', userId: u.id }, viewerIsOwner: false }
        }
      }
    }

    if (ws.isPublic) {
      const guestId = req.guestId ?? ''
      return { workspace: ws, viewer: { kind: 'guest', guestId }, viewerIsOwner: false }
    }
    throw new NotFoundException('workspace not found')
  }

  async write(req: Request, workspaceId: string): Promise<WriteAccessResult> {
    if (!req.isAuthenticated?.()) throw new UnauthorizedException('unauthenticated')
    const sessionUserId = req.user?.id
    if (!sessionUserId) throw new UnauthorizedException('no user in session')

    const [u] = await this.db
      .select({ id: users.id, githubLogin: users.githubLogin })
      .from(users)
      .where(eq(users.id, sessionUserId))
      .limit(1)
    if (!u) throw new UnauthorizedException('user not found')

    const isAdmin = this.auth.isAdmin(u.githubLogin)
    const whereClause = isAdmin
      ? eq(workspaces.id, workspaceId)
      : and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, u.id))
    const [ws] = await this.db.select().from(workspaces).where(whereClause).limit(1)
    if (!ws) throw new NotFoundException('workspace not found')

    return { workspace: ws, userId: u.id, isAdmin }
  }

  /** Throws UnauthorizedException if no session, returns the full User row. */
  async requireValidUser(req: Request) {
    if (!req.isAuthenticated?.() || !req.user?.id) {
      throw new UnauthorizedException('authentication required')
    }
    const u = await this.auth.findById(req.user.id)
    if (!u) {
      // Stale sealed-cookie session pointing at a wiped user.
      throw new UnauthorizedException('session refers to a user that no longer exists')
    }
    return u
  }

  async requireAdmin(req: Request) {
    const u = await this.requireValidUser(req)
    if (!this.auth.isAdmin(u.githubLogin)) throw new ForbiddenException('admin only')
    return u
  }
}
