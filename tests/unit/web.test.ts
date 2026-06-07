import { describe, expect, it } from 'vitest'
import { unwrapDdgRedirect, webFetch } from '../../server/lib/web'

describe('unwrapDdgRedirect', () => {
  // DDG wraps every result URL in `/l/?uddg=<encoded-url>` so it can
  // track clicks. The agent needs the raw URL it can feed back into
  // web_fetch, so we strip the wrapper.

  it('returns empty string for empty input', () => {
    expect(unwrapDdgRedirect('')).toBe('')
  })

  it('unwraps a protocol-relative DDG redirect', () => {
    const target = 'https://stackoverflow.com/q/123'
    const wrapped = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`
    expect(unwrapDdgRedirect(wrapped)).toBe(target)
  })

  it('unwraps an absolute DDG redirect', () => {
    const target = 'https://nuxt.com/docs/getting-started'
    const wrapped = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`
    expect(unwrapDdgRedirect(wrapped)).toBe(target)
  })

  it('returns the URL unchanged if there is no uddg param', () => {
    const direct = 'https://example.com/foo?bar=baz'
    expect(unwrapDdgRedirect(direct)).toBe(direct)
  })

  it('returns the input unchanged for non-URL strings', () => {
    expect(unwrapDdgRedirect('not a url')).toBe('not a url')
  })
})

describe('webFetch SSRF guard', () => {
  // The LLM picks every URL we hit. These would all reach internal
  // services on any cloud host (AWS / GCP metadata, app's own DB,
  // etc.) and must be refused before opening a socket.

  it('rejects loopback IPv4', async () => {
    const out = await webFetch('http://127.0.0.1:5432/')
    expect(out.reason).toBe('blocked')
    expect(out.markdown).toBe('')
  })

  it('rejects AWS / GCP cloud-metadata link-local IP', async () => {
    const out = await webFetch('http://169.254.169.254/latest/meta-data/')
    expect(out.reason).toBe('blocked')
  })

  it('rejects RFC 1918 (10/8) IPs', async () => {
    const out = await webFetch('http://10.0.0.1/admin')
    expect(out.reason).toBe('blocked')
  })

  it('rejects RFC 1918 (192.168/16) IPs', async () => {
    const out = await webFetch('http://192.168.1.1/router')
    expect(out.reason).toBe('blocked')
  })

  it('rejects IPv6 loopback', async () => {
    const out = await webFetch('http://[::1]:5432/')
    expect(out.reason).toBe('blocked')
  })

  it('rejects non-http schemes', async () => {
    const out = await webFetch('file:///etc/passwd')
    expect(out.reason).toBe('blocked')
  })

  it('rejects gopher://', async () => {
    const out = await webFetch('gopher://example.com/')
    expect(out.reason).toBe('blocked')
  })

  it('returns fetch_failed (not blocked) on empty input', async () => {
    const out = await webFetch('')
    expect(out.reason).toBe('fetch_failed')
  })

  it('rejects "localhost" by DNS-resolved IP, not by name', async () => {
    // `localhost` resolves to 127.0.0.1 / ::1 on every reasonable
    // host — `assertSafeUrl` does the resolution and refuses.
    const out = await webFetch('http://localhost:5432/')
    expect(out.reason).toBe('blocked')
  })
})
