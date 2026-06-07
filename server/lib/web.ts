/**
 * Web research helpers — search the open web + fetch + distill a URL
 * into Markdown. Used by the `web_search` and `web_fetch` KAG operators
 * so the chat agent can reason about library docs, Stack Overflow,
 * upstream issues, blog posts, etc., not just the indexed repo.
 *
 * Search backend: DuckDuckGo HTML endpoint (no API key, no quota
 * registration). Best-effort — DDG occasionally rate-limits or
 * returns CAPTCHA pages; we degrade gracefully with `reason: 'rate_limited'`.
 *
 * Fetch backend: plain fetch + cheerio for content extraction +
 * node-html-markdown for the HTML→Markdown conversion. Strips chrome
 * (script / style / nav / footer / aside / form / svg / iframe) before
 * conversion so the agent doesn't burn tokens on a navbar.
 *
 * SSRF: the LLM picks the URLs we fetch, so every request (including
 * each redirect hop) is validated against a private-network block-list
 * before the socket opens. See `assertSafeUrl` + `safeFetch` below.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { load as loadHtml } from 'cheerio'
import { NodeHtmlMarkdown } from 'node-html-markdown'
import { getLogger } from './logger'

const log = getLogger().child({ component: 'lib/web' })

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const FETCH_TIMEOUT_MS = 8_000
const MAX_HTML_BYTES = 1_500_000 // 1.5 MB after which we stop reading
const MAX_MARKDOWN_CHARS = 12_000 // truncate distilled markdown so it doesn't blow the prompt
const MAX_REDIRECTS = 5

const HTML_STRIP_SELECTORS = [
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'form',
  'header nav',
  'footer',
  'aside',
  'nav',
  '.cookie-banner',
  '.advertisement',
  '[role="banner"]',
  '[role="navigation"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
]

// ─── SSRF guard ───────────────────────────────────────────────────────

/**
 * IPv4 ranges we refuse to send the agent at — RFC 1918, loopback,
 * link-local (which includes cloud metadata 169.254.169.254), CGNAT,
 * TEST-NET, multicast, and reserved space.
 */
const PRIVATE_V4_PATTERNS: RegExp[] = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,
  /^192\.0\.0\./,
  /^192\.0\.2\./,
  /^198\.18\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^22[4-9]\./,
  /^2[3-5]\d\./,
]

function isBlockedIpv4(ip: string): boolean {
  return PRIVATE_V4_PATTERNS.some((re) => re.test(ip))
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  // fc00::/7 (unique-local) and fe80::/10 (link-local)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true
  }
  // IPv4-mapped (::ffff:1.2.3.4) — re-validate the embedded v4
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length)
    if (isIP(v4) === 4 && isBlockedIpv4(v4)) return true
  }
  return false
}

async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    throw new Error('invalid url')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`scheme ${u.protocol} not allowed`)
  }
  // `URL.hostname` keeps the brackets around IPv6 literals (`[::1]`);
  // `isIP` only accepts the bare form. Strip them.
  const host = u.hostname.startsWith('[') && u.hostname.endsWith(']')
    ? u.hostname.slice(1, -1)
    : u.hostname
  if (!host) throw new Error('missing host')
  const ipKind = isIP(host)
  if (ipKind === 4 && isBlockedIpv4(host)) throw new Error(`blocked ipv4 ${host}`)
  if (ipKind === 6 && isBlockedIpv6(host)) throw new Error(`blocked ipv6 ${host}`)
  if (ipKind === 0) {
    let addresses: Array<{ address: string; family: number }>
    try {
      addresses = await lookup(host, { all: true })
    } catch {
      throw new Error(`dns lookup failed for ${host}`)
    }
    for (const entry of addresses) {
      const addr = entry.address
      const fam = entry.family
      if (fam === 4 && isBlockedIpv4(addr)) throw new Error(`${host} resolves to blocked ipv4 ${addr}`)
      if (fam === 6 && isBlockedIpv6(addr)) throw new Error(`${host} resolves to blocked ipv6 ${addr}`)
    }
  }
  return u
}

/**
 * Follow redirects manually so we can re-validate each Location target.
 * Native fetch's `redirect: 'follow'` would jump straight to a private
 * IP if that's where the server tries to bounce us.
 */
async function safeFetch(url: string, headers: Record<string, string>): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(current)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(current, { redirect: 'manual', headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return res
      current = new URL(loc, current).toString()
      continue
    }
    return res
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`)
}

// ─── web_search ───────────────────────────────────────────────────────

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchEnvelope {
  results: WebSearchResult[]
  query: string
  reason?: 'rate_limited' | 'parse_failed' | 'fetch_failed'
}

/**
 * Search the open web via DuckDuckGo's HTML endpoint. Returns up to
 * `limit` results with title / canonical URL / snippet. DDG occasionally
 * blocks scrapers; degrade gracefully via the `reason` field rather
 * than throwing.
 */
export async function webSearch(query: string, limit = 8): Promise<WebSearchEnvelope> {
  const q = query.trim()
  if (!q) return { results: [], query: q }
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  let html: string
  try {
    html = await fetchTextWithBudget(url)
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), q }, 'web_search fetch failed')
    return { results: [], query: q, reason: 'fetch_failed' }
  }
  try {
    const $ = loadHtml(html)
    const out: WebSearchResult[] = []
    $('.result').each((_, el) => {
      if (out.length >= limit) return false
      const anchor = $(el).find('.result__title a.result__a').first()
      const title = anchor.text().trim()
      const rawHref = anchor.attr('href') ?? ''
      const url = unwrapDdgRedirect(rawHref)
      const snippet = $(el).find('.result__snippet').text().trim()
      if (title && url) out.push({ title, url, snippet })
      return
    })
    if (out.length === 0) {
      const lower = html.toLowerCase()
      const looksRateLimited = lower.includes('captcha') || lower.includes('anomaly')
      if (looksRateLimited) {
        return { results: [], query: q, reason: 'rate_limited' }
      }
      return { results: [], query: q, reason: 'parse_failed' }
    }
    return { results: out, query: q }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), q }, 'web_search parse failed')
    return { results: [], query: q, reason: 'parse_failed' }
  }
}

/**
 * DDG's HTML result anchors point at `//duckduckgo.com/l/?uddg=<encoded-url>&...`.
 * Strip the redirector so the agent gets the canonical URL it can
 * pass straight back into web_fetch.
 */
export function unwrapDdgRedirect(href: string): string {
  if (!href) return ''
  const normalised = href.startsWith('//') ? `https:${href}` : href
  try {
    const u = new URL(normalised)
    const uddg = u.searchParams.get('uddg')
    if (uddg) return decodeURIComponent(uddg)
    return u.toString()
  } catch {
    return href
  }
}

// ─── web_fetch ────────────────────────────────────────────────────────

export interface WebFetchResult {
  url: string
  title: string
  markdown: string
  truncated: boolean
  reason?: 'not_html' | 'fetch_failed' | 'too_large' | 'blocked'
}

const nhmConverter = new NodeHtmlMarkdown({
  keepDataImages: false,
  textReplace: [],
})

/**
 * Fetch a URL, strip non-content chrome, convert to Markdown,
 * truncate to MAX_MARKDOWN_CHARS. Honours the cap on response size
 * to avoid OOM-ing on accidental 50 MB pages. Refuses private-network
 * URLs (see `assertSafeUrl`) — those return `reason: 'blocked'`.
 */
export async function webFetch(url: string): Promise<WebFetchResult> {
  const target = url.trim()
  if (!target) return { url: target, title: '', markdown: '', truncated: false, reason: 'fetch_failed' }

  let response: Response
  try {
    response = await safeFetch(target, {
      'User-Agent': DEFAULT_UA,
      Accept: 'text/html,application/xhtml+xml',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn({ err: msg, url: target }, 'web_fetch network error')
    const blocked = msg.startsWith('blocked') || msg.includes('resolves to blocked') || msg.startsWith('scheme ')
    return {
      url: target,
      title: '',
      markdown: '',
      truncated: false,
      reason: blocked ? 'blocked' : 'fetch_failed',
    }
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  const isHtml = contentType.includes('html') || contentType.includes('xml') || contentType === ''
  if (!isHtml) {
    return { url: target, title: '', markdown: '', truncated: false, reason: 'not_html' }
  }

  const reader = response.body?.getReader()
  if (!reader) return { url: target, title: '', markdown: '', truncated: false, reason: 'fetch_failed' }
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let html = ''
  let bytes = 0
  let bailedOnSize = false
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_HTML_BYTES) {
      bailedOnSize = true
      break
    }
    html += decoder.decode(value, { stream: true })
  }
  html += decoder.decode()

  let $: ReturnType<typeof loadHtml>
  try {
    $ = loadHtml(html)
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), url: target }, 'web_fetch parse failed')
    return { url: target, title: '', markdown: '', truncated: false, reason: 'fetch_failed' }
  }
  for (const sel of HTML_STRIP_SELECTORS) $(sel).remove()
  const title = $('title').first().text().trim() || $('h1').first().text().trim() || ''

  const mainEl = $('main').first().length
    ? $('main').first()
    : $('article').first().length
      ? $('article').first()
      : $('body')

  const html2 = $.html(mainEl)
  let markdown = nhmConverter.translate(html2 || '').trim()
  let truncated = bailedOnSize
  if (markdown.length > MAX_MARKDOWN_CHARS) {
    markdown = markdown.slice(0, MAX_MARKDOWN_CHARS) + '\n\n…[truncated]'
    truncated = true
  }
  return { url: response.url || target, title, markdown, truncated, reason: bailedOnSize ? 'too_large' : undefined }
}

async function fetchTextWithBudget(url: string): Promise<string> {
  const res = await safeFetch(url, { 'User-Agent': DEFAULT_UA, Accept: 'text/html' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const reader = res.body?.getReader()
  if (!reader) throw new Error('no response body')
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let out = ''
  let bytes = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_HTML_BYTES) break
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}
