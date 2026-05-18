/**
 * Centralised authZ helpers for workspace endpoints.
 *
 * Three access tiers, in order of strictness:
 *
 * - readAccess: owner / admin / anyone-if-public. Used by GET endpoints
 *   that surface workspace data (graph, entities, chunks, chat history…).
 *   Returns the workspace row and a flag `viewerIsOwner` so handlers can
 *   gate write-ish side effects (e.g. saving chat history) accordingly.
 *
 * - writeAccess: owner / admin only. Used by mutations (reindex, delete,
 *   visibility toggle).
 *
 * - guestId: derives a stable per-browser id for unauthenticated guests
 *   from a httpOnly cookie. Used to attribute guest-mode quota counters.
 */
import { and, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { randomUUID } from 'node:crypto'
import { getDb } from '../db/client'
import { users, workspaces, type Workspace } from '../db/schema'
import { isAdminLogin } from './admin'

const GUEST_COOKIE = 'codegraph-guest'

export interface ReadAccessOk {
  workspace: Workspace
  viewer:
    | { kind: 'owner'; userId: string }
    | { kind: 'admin'; userId: string }
    | { kind: 'guest'; guestId: string }
  viewerIsOwner: boolean
}

export async function readAccess(
  event: H3Event,
  workspaceId: string,
): Promise<ReadAccessOk> {
  if (!workspaceId) {
    throw createError({ statusCode: 400, statusMessage: 'workspaceId required' })
  }
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  if (!ws) {
    throw createError({ statusCode: 404, statusMessage: 'workspace not found' })
  }

  const session = await getUserSession(event)
  const sessionUserId = session.user?.id as string | undefined
  if (sessionUserId) {
    // Check user exists + admin status.
    const [u] = await db
      .select({ id: users.id, githubLogin: users.githubLogin })
      .from(users)
      .where(eq(users.id, sessionUserId))
      .limit(1)
    if (u) {
      if (u.id === ws.ownerUserId) {
        return { workspace: ws, viewer: { kind: 'owner', userId: u.id }, viewerIsOwner: true }
      }
      if (isAdminLogin(u.githubLogin)) {
        return { workspace: ws, viewer: { kind: 'admin', userId: u.id }, viewerIsOwner: false }
      }
    }
  }

  if (ws.isPublic) {
    return {
      workspace: ws,
      viewer: { kind: 'guest', guestId: ensureGuestId(event) },
      viewerIsOwner: false,
    }
  }
  throw createError({ statusCode: 404, statusMessage: 'workspace not found' })
}

export interface WriteAccessOk {
  workspace: Workspace
  userId: string
  isAdmin: boolean
}

export async function writeAccess(
  event: H3Event,
  workspaceId: string,
): Promise<WriteAccessOk> {
  const config = useRuntimeConfig(event)
  const db = getDb(config.databaseUrl as string)
  const session = await requireUserSession(event)
  const sessionUserId = session.user?.id as string | undefined
  if (!sessionUserId) {
    throw createError({ statusCode: 401, statusMessage: 'unauthenticated' })
  }
  const [u] = await db
    .select({ id: users.id, githubLogin: users.githubLogin })
    .from(users)
    .where(eq(users.id, sessionUserId))
    .limit(1)
  if (!u) throw createError({ statusCode: 401, statusMessage: 'user not found' })

  const isAdmin = isAdminLogin(u.githubLogin)
  const whereClause = isAdmin
    ? eq(workspaces.id, workspaceId)
    : and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, u.id))
  const [ws] = await db.select().from(workspaces).where(whereClause).limit(1)
  if (!ws) {
    throw createError({ statusCode: 404, statusMessage: 'workspace not found' })
  }
  return { workspace: ws, userId: u.id, isAdmin }
}

export function ensureGuestId(event: H3Event): string {
  const existing = getCookie(event, GUEST_COOKIE)
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing
  const fresh = randomUUID()
  setCookie(event, GUEST_COOKIE, fresh, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return fresh
}
