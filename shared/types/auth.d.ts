declare module '#auth-utils' {
  interface User {
    id: string
    githubId: string
    login: string
    email: string | null
    avatarUrl: string | null
  }

  interface UserSession {
    loggedInAt?: number
  }

  interface SecureSessionData {
    // (intentionally empty for now)
    [key: string]: never
  }
}

export {}
