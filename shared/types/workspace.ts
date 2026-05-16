export type WorkspaceStatus =
  | 'pending'
  | 'cloning'
  | 'parsing'
  | 'extracting'
  | 'embedding'
  | 'ready'
  | 'failed'

export interface WorkspaceProgress {
  phase: WorkspaceStatus
  percent: number
  message: string
  updatedAt: string
}

export interface WorkspaceStats {
  files: number
  entities: number
  relations: number
  chunks: number
  tokensSpent: number
}
