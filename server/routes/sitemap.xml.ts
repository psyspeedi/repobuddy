/**
 * Dynamic sitemap. Includes the landing + every ready+public workspace
 * so search engines can crawl the explorable surface. Auth-only pages
 * are excluded.
 *
 * Served at /sitemap.xml — Nitro file route. Cached for 1h via
 * Cache-Control header (the workspace list changes slowly).
 */
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { workspaces } from '../db/schema'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const appUrl = ((config.public.appUrl as string | undefined) ?? 'http://localhost:3000').replace(/\/$/, '')
  const db = getDb(config.databaseUrl as string)

  const rows = await db
    .select({
      id: workspaces.id,
      lastIndexedAt: workspaces.lastIndexedAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(and(eq(workspaces.isPublic, true), eq(workspaces.status, 'ready')))
    .orderBy(desc(workspaces.lastIndexedAt))
    .limit(1000)

  const today = new Date().toISOString().slice(0, 10)
  const urls: string[] = []
  urls.push(`<url><loc>${appUrl}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>`)
  for (const r of rows) {
    const lastmod = (r.lastIndexedAt ?? r.updatedAt).toISOString().slice(0, 10)
    urls.push(`<url><loc>${appUrl}/w/${r.id}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`)
    urls.push(`<url><loc>${appUrl}/w/${r.id}/graph</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.4</priority></url>`)
  }

  setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'public, max-age=3600')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls.join('\n'),
    '</urlset>',
  ].join('\n')
})
