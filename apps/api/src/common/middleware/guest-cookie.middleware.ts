import { Injectable, NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'

const GUEST_COOKIE = 'repobuddy-guest'
const UUID_RE = /^[0-9a-f-]{36}$/i

/**
 * Hands every visitor a stable per-browser id via httpOnly cookie.
 * Used to attribute quota counters and rate-limits to anonymous
 * guests browsing public workspaces. `req.guestId` is always set
 * downstream.
 */
@Injectable()
export class GuestCookieMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const existing = req.cookies?.[GUEST_COOKIE] as string | undefined
    if (existing && UUID_RE.test(existing)) {
      req.guestId = existing
    } else {
      const fresh = randomUUID()
      res.cookie(GUEST_COOKIE, fresh, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 1000 * 60 * 60 * 24 * 30, // 30d
      })
      req.guestId = fresh
    }
    next()
  }
}
