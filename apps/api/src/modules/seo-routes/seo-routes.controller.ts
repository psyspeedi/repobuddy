import { Controller, Get, Header, Inject, NotFoundException, Param } from '@nestjs/common'
import { and, desc, eq } from 'drizzle-orm'
import { users, workspaces } from '#server/db/schema'
import { TypedConfigService } from '../config/typed-config.service'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

@Controller()
export class SeoRoutesController {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(TypedConfigService) private readonly config: TypedConfigService,
  ) {}

  @Get('robots.txt')
  @Header('content-type', 'text/plain; charset=utf-8')
  robots(): string {
    const appUrl = this.config.get('APP_URL') ?? 'http://localhost:3000'
    return [
      'User-agent: *',
      'Allow: /$',
      'Allow: /login',
      'Allow: /w/',
      'Disallow: /admin',
      'Disallow: /settings',
      'Disallow: /api/',
      'Disallow: /auth/',
      '',
      `Sitemap: ${appUrl}/sitemap.xml`,
      `Sitemap: ${appUrl}/feed.xml`,
      '',
    ].join('\n')
  }

  @Get('sitemap.xml')
  @Header('content-type', 'application/xml; charset=utf-8')
  @Header('cache-control', 'public, max-age=3600')
  async sitemap(): Promise<string> {
    const appUrl = (this.config.get('APP_URL') ?? 'http://localhost:3000').replace(/\/$/, '')
    const rows = await this.db
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
    urls.push(
      `<url><loc>${appUrl}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
    )
    for (const r of rows) {
      const lastmod = (r.lastIndexedAt ?? r.updatedAt).toISOString().slice(0, 10)
      urls.push(
        `<url><loc>${appUrl}/w/${r.id}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`,
      )
      urls.push(
        `<url><loc>${appUrl}/w/${r.id}/explore</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.4</priority></url>`,
      )
    }
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      urls.join('\n'),
      '</urlset>',
    ].join('\n')
  }

  @Get('feed.xml')
  @Header('content-type', 'application/rss+xml; charset=utf-8')
  @Header('cache-control', 'public, max-age=1800')
  async feed(): Promise<string> {
    const base = (this.config.get('APP_URL') ?? '').replace(/\/$/, '') || 'http://localhost:3000'
    const rows = await this.db
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

    const items = rows
      .map((r) => {
        const link = `${base}/w/${r.id}`
        const pub = (r.lastIndexedAt ?? new Date()).toUTCString()
        const desc = `${r.ownerLogin ? `@${r.ownerLogin} · ` : ''}${
          r.languages?.length ? r.languages.join(', ') : 'mixed'
        } · ${r.sourceUrl ?? ''}`
        return `
    <item>
      <title>${esc(r.name)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${pub}</pubDate>
      <description>${esc(desc)}</description>
    </item>`
      })
      .join('')
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
  }

  @Get('indexnow/:filename')
  @Header('content-type', 'text/plain; charset=utf-8')
  indexnow(@Param('filename') filename: string): string {
    const requested = filename.replace(/\.txt$/, '')
    const real = process.env.INDEXNOW_KEY
    if (!requested || !real || requested !== real) {
      throw new NotFoundException('not found')
    }
    return real
  }
}
