export interface SessionUser {
  id: string
  githubId: string
  login: string
  email: string | null
  avatarUrl: string | null
}

// Augment Express request with our SessionUser shape so guards /
// controllers see `req.user` typed without a cast.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface User extends SessionUser {}
    interface Request {
      guestId?: string
    }
  }
}
