/**
 * Daily digest worker — sends a Telegram summary of the last 24h.
 *
 * Counts come straight from Postgres (audit_events, chat_messages,
 * llm_cost_log) rather than Prometheus, so admin users can read the
 * numbers from /admin and the digest, and they'll agree.
 */
import { sql } from 'drizzle-orm'
import type { Database } from '#server/db/client'
import { sendAlert } from '#server/lib/alerts'
import { getLogger } from '#server/lib/logger'

const log = getLogger().child({ component: 'worker/digest' })

interface DigestNumbers {
  costToday: number
  costYesterday: number
  newUsers: number
  newWorkspaces: number
  deletedWorkspaces: number
  chatMessages: number
  failedJobs: number
  topUsers: { login: string; messages: number }[]
}

export async function runDailyDigest(db: Database): Promise<void> {
  const n = await loadNumbers(db)
  const lines: string[] = []
  lines.push(`📊 *Daily digest*`)
  lines.push('')
  lines.push(`💰 LLM cost today: *$${n.costToday.toFixed(2)}*  (yest: $${n.costYesterday.toFixed(2)})`)
  lines.push(`💬 Chat messages last 24h: *${n.chatMessages}*`)
  lines.push(`👤 New users: ${n.newUsers}`)
  lines.push(`📁 Workspaces +${n.newWorkspaces} / -${n.deletedWorkspaces}`)
  if (n.failedJobs > 0) lines.push(`❌ Failed index jobs: ${n.failedJobs}`)
  if (n.topUsers.length > 0) {
    lines.push('')
    lines.push('*Top chatty users (24h):*')
    for (const u of n.topUsers) lines.push(`• @${u.login} — ${u.messages}`)
  }
  await sendAlert(lines.join('\n'), { severity: 'info', key: `digest-${new Date().toISOString().slice(0, 10)}`, cooldownMs: 23 * 60 * 60 * 1000 })
  log.info(n, 'digest sent')
}

async function loadNumbers(db: Database): Promise<DigestNumbers> {
  const [row] = await db.execute<{
    cost_today: number
    cost_yesterday: number
    new_users: number
    new_workspaces: number
    deleted_workspaces: number
    chat_messages: number
    failed_jobs: number
  }>(sql`
    SELECT
      coalesce((SELECT sum(usd_cents) FROM llm_cost_log WHERE created_at > now() - interval '24 hours'), 0)::int   AS cost_today,
      coalesce((SELECT sum(usd_cents) FROM llm_cost_log
        WHERE created_at > now() - interval '48 hours' AND created_at <= now() - interval '24 hours'), 0)::int     AS cost_yesterday,
      (SELECT count(*) FROM users WHERE created_at > now() - interval '24 hours')::int                              AS new_users,
      (SELECT count(*) FROM audit_events WHERE action = 'workspace.create' AND at > now() - interval '24 hours')::int  AS new_workspaces,
      (SELECT count(*) FROM audit_events WHERE action IN ('workspace.delete','admin.delete_workspace') AND at > now() - interval '24 hours')::int AS deleted_workspaces,
      (SELECT count(*) FROM chat_messages WHERE role = 'user' AND created_at > now() - interval '24 hours')::int   AS chat_messages,
      (SELECT count(*) FROM workspaces WHERE status = 'failed' AND updated_at > now() - interval '24 hours')::int  AS failed_jobs
  `)
  const top = await db.execute<{ github_login: string; n: number }>(sql`
    SELECT u.github_login, count(*)::int AS n
    FROM chat_messages m
    JOIN chat_sessions s ON s.id = m.session_id
    JOIN users u ON u.id = s.user_id
    WHERE m.role = 'user' AND m.created_at > now() - interval '24 hours'
    GROUP BY u.github_login
    ORDER BY n DESC
    LIMIT 5
  `)
  return {
    costToday: Number(row?.cost_today ?? 0) / 100,
    costYesterday: Number(row?.cost_yesterday ?? 0) / 100,
    newUsers: Number(row?.new_users ?? 0),
    newWorkspaces: Number(row?.new_workspaces ?? 0),
    deletedWorkspaces: Number(row?.deleted_workspaces ?? 0),
    chatMessages: Number(row?.chat_messages ?? 0),
    failedJobs: Number(row?.failed_jobs ?? 0),
    topUsers: [...top].map((r) => ({ login: r.github_login, messages: Number(r.n) })),
  }
}
