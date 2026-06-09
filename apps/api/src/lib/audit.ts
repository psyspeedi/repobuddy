/**
 * Append-only audit logger. Helpers + recordAudit() that every
 * mutation endpoint should call after success.
 *
 * Failures are swallowed (logged) — auditing must never block the user
 * operation that triggered it. Surface coverage > guaranteed coverage.
 */
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

// getClientIp removed — NestJS controllers use Express `req.ip` directly.
