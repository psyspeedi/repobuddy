/**
 * Robots policy. Index public landing + public workspaces only; keep
 * everything authenticated or behind privacy off-limits.
 *
 * Served at /robots.txt via Nitro's `server/routes` mapping.
 */
export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const appUrl = (config.public.appUrl as string | undefined) ?? 'http://localhost:3000'
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
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
    '',
  ].join('\n')
})
