/**
 * Shared types for the find_resolution operator. Server emits the
 * envelope as a tool_step result; the chat UI renders it as a banner
 * above the assistant's reply. Keeping the contract in `shared/`
 * means both ends compile against the same shape.
 */

export type ResolutionStatus =
  | 'merged'
  | 'open_pr'
  | 'draft_pr'
  | 'stale_pr'
  | 'duplicate_closed'
  | 'related'
  | 'none'

export type ResolutionConfidence = 'high' | 'medium' | 'low'

export interface ResolutionCommit {
  sha: string
  message: string
  author: string
  date: string
}

export interface ResolutionPr {
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  draft: boolean
  merged: boolean
  mergedAt: string | null
  author: string | null
  lastCommitAt: string | null
  stale: boolean
  bodyExcerpt: string
}

export interface ResolutionDuplicate {
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  similarity: number
}

export interface ResolutionEnvelope {
  issueNumber: number
  status: ResolutionStatus
  confidence: ResolutionConfidence
  mergedByCommits: ResolutionCommit[]
  linkedPullRequests: ResolutionPr[]
  duplicateCandidates: ResolutionDuplicate[]
  reason?: 'no_source_url' | 'not_github' | 'rate_limited' | 'fetch_failed' | 'no_issue'
}
