/**
 * README badge endpoint.
 *
 * Lives outside the global `api` prefix (see the `exclude` list in
 * main.ts) so a maintainer can paste a short, stable
 * `<APP_URL>/badge/<id>.svg` into README.md or CONTRIBUTING.md. That
 * badge is the product's distribution path: the maintainer pays to
 * index their own repository once, and every contributor who lands on
 * the README arrives as a guest with the workspace already built.
 *
 * The route is unauthenticated — GitHub proxies README images through
 * camo, which carries no cookies — so `is_public` is the only access
 * boundary here.
 */
import { Controller, Get, Header, Inject, Param, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { and, eq } from 'drizzle-orm'
import { workspaces } from '#server/db/schema'
import { rateLimitTake } from '#server/lib/rate-limit'
import { DRIZZLE_DB, type DrizzleDb } from '../drizzle/drizzle.tokens'
import { BRAND_COLOR, NEUTRAL_COLOR, renderBadge } from './internals/svg'

/** Postgres rejects a malformed uuid with an error rather than zero
 * rows, so ids are shape-checked before they reach the query. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const LABEL = 'RepoBuddy'
const MESSAGE_OK = 'explore this repo'
const MESSAGE_MISSING = 'not found'

/** camo re-fetches aggressively; without a cache window every view of
 * the README would reach the database. Five minutes is short enough
 * that flipping a workspace public shows up quickly. */
const CACHE_OK = 'public, max-age=300'
/** The fallback caches for a minute only: a maintainer who just made
 * the workspace public should not stare at "not found". */
const CACHE_MISSING = 'public, max-age=60'

/**
 * Per-IP ceiling on how often one client can make us hit the database.
 * Cache-Control is an instruction to caches, not to us: a direct
 * request stream ignores it entirely, and every one of those reaches
 * Postgres. Deliberately loose — a README badge is legitimately fetched
 * a lot, and camo re-fetches on a schedule of its own — so this only
 * catches a flood, never a real reader.
 */
const BADGE_RATE_LIMIT = 60
const BADGE_RATE_WINDOW_SEC = 60

@Controller()
export class BadgeController {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * Matched as `:file` rather than `:id.svg` because Express 4 and 5
   * disagree on suffix syntax in route patterns; the same trick is used
   * for `indexnow/:filename` in seo-routes.
   *
   * A private, missing or malformed id all return the same neutral
   * badge with HTTP 200 — never a 404 and never the workspace name.
   * Two reasons: distinguishing "private" from "nonexistent" would turn
   * the endpoint into an id oracle, and a non-200 renders in the README
   * as a broken-image glyph, which reads as "RepoBuddy is down" rather
   * than "this badge points at nothing".
   *
   * Over the rate limit the neutral badge is served without touching
   * the database — a flood gets a picture, not an error, for the same
   * reason a missing id does.
   */
  @Get('badge/:file')
  @Header('content-type', 'image/svg+xml; charset=utf-8')
  async badge(
    @Param('file') file: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const id = /^(.+)\.svg$/.exec(file)?.[1] ?? ''
    const quota = await rateLimitTake(
      `cg:rl:badge:ip:${req.ip ?? 'unknown'}`,
      BADGE_RATE_LIMIT,
      BADGE_RATE_WINDOW_SEC,
    )
    const visible = quota.ok ? await this.isPublicWorkspace(id) : false
    // A throttled response says nothing about the workspace, so it must
    // not be cached as if it did — otherwise one burst would pin a live
    // badge to "not found" in every shared cache for the window.
    res.setHeader(
      'cache-control',
      quota.ok ? (visible ? CACHE_OK : CACHE_MISSING) : 'no-store',
    )
    return renderBadge({
      label: LABEL,
      message: visible ? MESSAGE_OK : MESSAGE_MISSING,
      color: visible ? BRAND_COLOR : NEUTRAL_COLOR,
    })
  }

  /**
   * Existence check only — the badge carries no workspace name, owner
   * or stats, so nothing but the boolean leaves this method.
   *
   * `status` is deliberately not filtered: a public workspace that is
   * mid-reindex still has a page worth linking to, and a README badge
   * flickering to "not found" during every reindex would be worse than
   * useless.
   *
   * Index freshness is deliberately not reflected either — the badge
   * has exactly two states, and a stale index looks the same as a fresh
   * one. That is a known trade-off, not an oversight: the workspace
   * page already reports "N commits behind" to anyone who follows the
   * badge, and putting a number in the README image would make it
   * change under the maintainer's feet on every upstream commit. If
   * that call is ever revisited, the cached freshness endpoint is where
   * the number would come from.
   */
  private async isPublicWorkspace(id: string): Promise<boolean> {
    if (!UUID_RE.test(id)) return false
    const [row] = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, id), eq(workspaces.isPublic, true)))
      .limit(1)
    return !!row
  }
}
