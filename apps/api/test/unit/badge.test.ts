import { describe, expect, it } from 'vitest'
import { BRAND_COLOR, NEUTRAL_COLOR, renderBadge } from '#modules/badge/internals/svg'

/** Minimal well-formedness check — the badge is served as an image, so
 * a stray unescaped character makes it render as nothing at all. */
function parses(svg: string): boolean {
  const opens = (svg.match(/<[a-zA-Z]/g) ?? []).length
  const closes = (svg.match(/<\/[a-zA-Z]|\/>/g) ?? []).length
  return opens === closes
}

describe('renderBadge', () => {
  it('emits a self-contained svg with no external references', () => {
    const svg = renderBadge({ label: 'RepoBuddy', message: 'explore this repo', color: BRAND_COLOR })
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(parses(svg)).toBe(true)
    // No webfonts, no shields.io, no <image href>: a README badge must
    // not make the reader's browser hit a third party.
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
    expect(svg).not.toMatch(/@import|<image|xlink:href/)
  })

  it('widens the badge as the text grows', () => {
    const short = renderBadge({ label: 'A', message: 'B', color: BRAND_COLOR })
    const long = renderBadge({ label: 'A', message: 'B'.repeat(40), color: BRAND_COLOR })
    const widthOf = (svg: string) => Number(/width="(\d+)"/.exec(svg)![1])
    expect(widthOf(long)).toBeGreaterThan(widthOf(short))
  })

  it('never forces glyph spacing with textLength', () => {
    // textLength is a target width, not a cap: because the cell width
    // is a padded estimate, setting it made browsers stretch the text
    // to fill the padding. Pinned because the attribute is invisible to
    // librsvg, so only a browser would have shown the regression.
    const svg = renderBadge({ label: 'RepoBuddy', message: 'explore this repo', color: BRAND_COLOR })
    expect(svg).not.toContain('textLength')
    expect(svg).not.toContain('lengthAdjust')
  })

  it('escapes markup in the text instead of emitting it raw', () => {
    const svg = renderBadge({ label: '<a>&"', message: 'x', color: NEUTRAL_COLOR })
    expect(svg).not.toContain('<a>')
    expect(svg).toContain('&lt;a&gt;&amp;&quot;')
    expect(parses(svg)).toBe(true)
  })

  it('renders the two states in different colours', () => {
    const ok = renderBadge({ label: 'RepoBuddy', message: 'explore this repo', color: BRAND_COLOR })
    const missing = renderBadge({ label: 'RepoBuddy', message: 'not found', color: NEUTRAL_COLOR })
    expect(ok).toContain(BRAND_COLOR)
    expect(missing).toContain(NEUTRAL_COLOR)
    expect(missing).not.toContain(BRAND_COLOR)
  })

  it('leaks nothing beyond the text it was given', () => {
    // The controller only ever passes constants; this pins that the
    // renderer cannot smuggle anything else into the document.
    const svg = renderBadge({ label: 'RepoBuddy', message: 'not found', color: NEUTRAL_COLOR })
    expect(svg).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })
})
