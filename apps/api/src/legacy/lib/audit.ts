/**
 * Append-only audit logger. Helpers + recordAudit() that every
 * mutation endpoint should call after success.
 *
 * Failures are swallowed (logged) — auditing must never block the user
 * operation that triggered it. Surface coverage > guaranteed coverage.
 */
import type { H3Event } from 'h3'
import type { Database } from '../db/client'
import { auditEvents } from '../db/schema'
import { getLogger } from './logger'

const log = getLogger().child({ component: 'audit' })

export type AuditAction =
  | 'workspace.create'
  | 'workspace.delete'
  | 'workspace.reindex'
  | 'workspace.visibility'
  | 'byok.set'
  | 'byok.clear'
  | 'admin.delete_workspace'
  | 'admin.toggle_visibility'

export interface AuditInput {
  userId: string | null
  actorLogin: string | null
  action: AuditAction
  targetType?: string
  targetId?: string
  metadata?: Record<string, unknown>
  ip?: string | null
}

export async function recordAudit(db: Database, input: AuditInput): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      userId: input.userId,
      actorLogin: input.actorLogin,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
      ip: input.ip ?? null,
    })
  } catch (err) {
    log.warn({ err, action: input.action }, 'failed to write audit event')
  }
}

/**
 * Best-effort IP extraction from an H3 event. Looks at standard
 * proxy headers first (Caddy / nginx set X-Forwarded-For), falls back
 * to socket address. Returns null when nothing usable found.
 */
export function getClientIp(event: H3Event): string | null {
  const xff = getRequestHeader(event, 'x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const real = getRequestHeader(event, 'x-real-ip')
  if (real) return real.trim()
  const node = event.node?.req?.socket
  if (node && 'remoteAddress' in node) {
    return (node.remoteAddress as string | undefined) ?? null
  }
  return null
}
