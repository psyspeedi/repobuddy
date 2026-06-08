/**
 * RSS 2.0 feed of public workspaces. Boosts discoverability for
 * services like Feedly/Inoreader and gives us a stable URL to
 * cross-post when monetisation/sharing flows kick in.
 *
 * Cached for 30 minutes — same workspaces don't reorder every second.
 */
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { workspaces, users } from '../db/schema'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const base = ((config.public.appUrl as string | undefined) ?? '').replace(/\/$/, '') || 'http://localhost:3000'
  const db = getDb(config.databaseUrl as string)

  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      sourceUrl: workspaces.sourceUrl,
      languages: workspaces.languages,
      lastIndexedAt: workspaces.lastIndexedAt,
      ownerLogin: users.githubLogin,
    })
    .from(workspaces)
    .leftJoin(users, eq(users.id, workspaces.ownerUserId))
    .where(and(eq(workspaces.isPublic, true), eq(workspaces.status, 'ready')))
    .orderBy(desc(workspaces.lastIndexedAt))
    .limit(50)

  const items = rows.map((r) => {
    const link = `${base}/w/${r.id}`
    const pub = (r.lastIndexedAt ?? new Date()).toUTCString()
    const desc = `${r.ownerLogin ? `@${r.ownerLogin} · ` : ''}${r.languages?.length ? r.languages.join(', ') : 'mixed'} · ${r.sourceUrl ?? ''}`
    return `
    <item>
      <title>${esc(r.name)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${pub}</pubDate>
      <description>${esc(desc)}</description>
    </item>`
  }).join('')

  setResponseHeader(event, 'content-type', 'application/rss+xml; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'public, max-age=1800')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>RepoBuddy — public workspaces</title>
    <link>${base}/</link>
    <description>New and recently re-indexed public workspaces on RepoBuddy.</description>
    <language>en</language>
    ${items}
  </channel>
</rss>`
})
