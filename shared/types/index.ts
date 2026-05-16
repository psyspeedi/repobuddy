export type WorkspaceStatus =
  | 'pending'
  | 'cloning'
  | 'parsing'
  | 'extracting'
  | 'embedding'
  | 'ready'
  | 'failed'

export type SourceType = 'github' | 'upload'

export type Language = 'typescript' | 'javascript' | 'python' | 'go'

export const SUPPORTED_LANGUAGES = ['typescript', 'javascript', 'python', 'go'] as const

export type EntityType =
  | 'file'
  | 'module'
  | 'class'
  | 'function'
  | 'type'
  | 'variable'
  | 'component'
  | 'route'
  | 'test'
  | 'concept'
  | 'pattern'
  | 'decision'
  | 'commit'
  | 'pull_request'
  | 'person'
  | 'document'

export type RelationType =
  | 'imports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'uses_type'
  | 'defined_in'
  | 'contained_in'
  | 'renders'
  | 'handles'
  | 'tested_by'
  | 'implements_concept'
  | 'follows_pattern'
  | 'mentioned_in'
  | 'modified_by'
  | 'authored'
  | 'introduced_in'
  | 'relates_to'

export type ChunkSourceType = 'code' | 'doc' | 'pr_description' | 'commit_message'

export type ChatRole = 'user' | 'assistant'
