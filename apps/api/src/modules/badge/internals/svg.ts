/**
 * Flat-badge SVG renderer.
 *
 * Badges are drawn here rather than proxied from shields.io: a README
 * badge is fetched on every page view of the repo, and pointing it at a
 * third party would hand that traffic — and the workspace ids embedded
 * in the URL — to someone else, plus add an outage we do not control.
 *
 * Layout follows the classic two-cell flat badge (dark label cell +
 * coloured message cell, 20px tall, 3px corner radius) so it sits
 * naturally next to the CI/coverage badges already in a README.
 *
 * Text is laid out with a monospace approximation: the system font
 * stack renders differently per platform, so there is no exact metric
 * to measure against anyway. A slightly generous per-character advance
 * keeps text inside its cell everywhere instead of only on the machine
 * that rendered it.
 *
 * That generosity is why the cells carry no `textLength`. `textLength`
 * is a target width, not a maximum: a browser stretches the glyph
 * spacing to hit it exactly, so pairing it with a padded estimate
 * renders "e x p l o r e   t h i s   r e p o" rather than a wider
 * cell. (librsvg ignores the attribute, so it only shows up where it
 * matters — the reader's browser.) Text is centred in its cell and
 * left at its natural width instead.
 */

/** Font size of both labels, in px. Matches the shields.io flat look. */
const FONT_SIZE = 11
/** Horizontal advance per character at FONT_SIZE, rounded up. */
const CHAR_WIDTH = 6.6
/** Padding on each side of a cell's text. */
const PADDING = 6
const HEIGHT = 20

/** System stack — a badge must render without loading a webfont. */
const FONT_FAMILY =
  '-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif'

/** Left cell: near-black, same tone GitHub uses for its own chrome. */
const LABEL_BG = '#24292f'
/** Right cell for a live workspace: the app's primary (hsl 252 75% 58%). */
export const BRAND_COLOR = '#6444e4'
/** Right cell for the neutral fallback badge. */
export const NEUTRAL_COLOR = '#9f9f9f'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function cellWidth(text: string): number {
  return Math.round(text.length * CHAR_WIDTH + PADDING * 2)
}

export interface BadgeSpec {
  /** Left cell text. */
  label: string
  /** Right cell text. */
  message: string
  /** Right cell background, as a hex colour. */
  color: string
}

/**
 * Render a two-cell flat badge as a standalone SVG document.
 *
 * Both cells get a shadow copy of their text one pixel lower at 30%
 * black — that is what gives flat badges their engraved look on a
 * coloured background.
 */
export function renderBadge({ label, message, color }: BadgeSpec): string {
  const labelWidth = cellWidth(label)
  const messageWidth = cellWidth(message)
  const total = labelWidth + messageWidth
  // Text anchors sit at the centre of their cell. x10 units because the
  // <g> is scaled down by 10, which keeps the anchor positions on clean
  // integers after rounding.
  const labelX = (labelWidth / 2) * 10
  const messageX = (labelWidth + messageWidth / 2) * 10
  const alt = `${label}: ${message}`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${HEIGHT}" role="img" aria-label="${esc(alt)}">
<title>${esc(alt)}</title>
<linearGradient id="rb-s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="rb-r"><rect width="${total}" height="${HEIGHT}" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#rb-r)">
<rect width="${labelWidth}" height="${HEIGHT}" fill="${LABEL_BG}"/>
<rect x="${labelWidth}" width="${messageWidth}" height="${HEIGHT}" fill="${color}"/>
<rect width="${total}" height="${HEIGHT}" fill="url(#rb-s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE * 10}" transform="scale(.1)">
<text x="${labelX}" y="150" fill="#010101" fill-opacity=".3">${esc(label)}</text>
<text x="${labelX}" y="140">${esc(label)}</text>
<text x="${messageX}" y="150" fill="#010101" fill-opacity=".3">${esc(message)}</text>
<text x="${messageX}" y="140">${esc(message)}</text>
</g>
</svg>
`
}
