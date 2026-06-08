/**
 * KAG operator library. Each operator is an async function over a typed
 * parameter object; the executor (kag/executor.ts) dispatches them by
 * name with substituted params and stores the result.
 *
 * Operators are pure with respect to the database — they read graph
 * state but never mutate it.
 *
 * This file is the registry + the `answer` wrapper (only the executor
 * calls it). Operator implementations live in domain-specific siblings:
 *   - _types.ts          shared OperatorContext / GraphEntity
 *   - _helpers.ts        idsFromParam, entityProjection
 *   - traversal.ts       find_symbol, find_file, get_callers/callees/
 *                        dependencies/dependents, find_implementations,
 *                        get_summary, walkthrough
 *   - git.ts             git_history
 *   - search.ts          find_by_concept, vector_search_chunks,
 *                        hybrid_search, search_docs, retrieve_code_chunks
 *   - github.ts          list_issues, list_prs, find_prs_for_issue,
 *                        find_similar_issues, find_resolution
 *   - insights.ts        tests_for, list_concepts, read_file,
 *                        get_project_overview
 *   - web.ts             web_search, web_fetch
 *   - mutations.ts       propose_edit
 *   - answer.ts          finalising LLM stream
 *   - hybrid_search.ts   RRF helper used by both search and answer
 */
import { Injectable } from '@nestjs/common'
import type { LinkedChunk } from '../../../../lib/github-issue-linking'
import type { ProjectOverview } from '../../../../lib/project-overview'
import { answer, type AnswerStreamChunk } from './answer'
import { hybridSearch } from './hybrid_search'
import {
  findImplementations,
  findFile,
  findSymbol,
  getCallees,
  getCallers,
  getDependencies,
  getDependents,
  getSummary,
  walkthrough,
  FindFileOperator,
  FindImplementationsOperator,
  FindSymbolOperator,
  GetCalleesOperator,
  GetCallersOperator,
  GetDependenciesOperator,
  GetDependentsOperator,
  GetSummaryOperator,
  WalkthroughOperator,
} from './traversal'
import { gitHistory, GitHistoryOperator } from './git'
import {
  findByConcept,
  hybridSearchOp,
  retrieveCodeChunks,
  searchDocs,
  vectorSearchChunks,
  FindByConceptOperator,
  HybridSearchOperator,
  RetrieveCodeChunksOperator,
  SearchDocsOperator,
  VectorSearchChunksOperator,
} from './search'
import {
  findPrsForIssue,
  findResolution,
  findSimilarIssues,
  listIssues,
  listPrs,
  type IssueResult,
  FindPrsForIssueOperator,
  FindResolutionOperator,
  FindSimilarIssuesOperator,
  ListIssuesOperator,
  ListPrsOperator,
} from './github'
import {
  getProjectOverviewOp,
  listConcepts,
  readFileOp,
  testsFor,
  GetProjectOverviewOperator,
  ListConceptsOperator,
  ReadFileOperator,
  TestsForOperator,
} from './insights'
import { webFetchOp, webSearchOp, WebFetchOperator, WebSearchOperator } from './web'
import { proposeEditOp, ProposeEditOperator } from './mutations'
import type { KagOperator } from './_interface'
import type { OperatorContext } from './_types'

// Re-export the DI surface so `kag.module.ts` / services / future
// callers can keep a single import path.
export { KAG_OPERATOR, type KagOperator } from './_interface'
export { KagOperatorsRegistry } from './_registry'

// ---- Public surface — re-exports so call-sites can keep importing
// from `operators/index` without knowing about the split. ----
export type { OperatorContext, GraphEntity } from './_types'
export type {
  FindSymbolParams,
  FindFileParams,
  FindImplementationsParams,
  WalkthroughParams,
  WalkthroughResult,
  GetSummaryParams,
} from './traversal'
export { findSymbol, findFile, getCallers, getCallees, getDependencies, getDependents, findImplementations, getSummary, walkthrough } from './traversal'
export type { GitHistoryParams } from './git'
export { gitHistory } from './git'
export type {
  FindByConceptParams,
  VectorSearchParams,
  RetrieveCodeChunksParams,
} from './search'
export { findByConcept, hybridSearchOp, retrieveCodeChunks, searchDocs, vectorSearchChunks } from './search'
export type {
  FindPrsForIssueParams,
  FindResolutionParams,
  FindSimilarIssuesParams,
  IssueResult,
  IssuesEnvelope,
  ListIssuesParams,
  ListPrsParams,
  PrResult,
  PrSummary,
  PrsEnvelope,
  ResolutionCommit,
  ResolutionDuplicate,
  ResolutionEnvelope,
  ResolutionPr,
  ResolutionStatus,
  SimilarIssueResult,
} from './github'
export { classifyResolution, findPrsForIssue, findResolution, findSimilarIssues, listIssues, listPrs, FIX_REF_RE_FOR } from './github'
export type {
  ListConceptsParams,
  ProjectOverviewParams,
  ReadFileParams,
  TestsForParams,
} from './insights'
export { getProjectOverviewOp, listConcepts, readFileOp, testsFor } from './insights'
export type { WebFetchParams, WebSearchParams } from './web'
export { webFetchOp, webSearchOp } from './web'
export type { ProposeEditParams, ProposeEditResult } from './mutations'
export { proposeEditOp } from './mutations'

// ---------- answer wrapper for plan executor ----------
// Lives here (rather than in answer.ts) because it folds together
// envelopes produced by ALL the operators above into the prompt
// `answer()` then drives. Easier to keep next to the registry that
// dispatches it.
export async function* answerOp(
  params: {
    question: string
    context: unknown[]
    style?: 'concise' | 'detailed'
  },
  ctx: OperatorContext,
): AsyncGenerator<AnswerStreamChunk> {
  const chunks: { id: string; text: string; filePath?: string | null; startLine?: number | null; endLine?: number | null }[] = []
  const entitiesContext: {
    id: string
    name: string
    type: string
    description?: string | null
    qualifiedName?: string | null
    metadata?: Record<string, unknown> | null
    filePath?: string | null
    startLine?: number | null
    endLine?: number | null
    language?: string | null
    signature?: string | null
  }[] = []

  const seenEntityIds = new Set<string>()
  const seenChunkIds = new Set<string>()
  // Mermaid blocks contributed by walkthrough operator runs. Inlined
  // into the user prompt with an instruction to include them verbatim.
  const mermaidBlocks: string[] = []
  // GitHub issues collected from list_issues envelopes. Rendered as a
  // dedicated section in the user prompt; the model is asked to cite
  // issue numbers (#42) in its answer.
  const issueResults: IssueResult[] = []
  // Project overview from get_project_overview operator. Surfaced in
  // the prompt with entrypoints + core abstractions + stats so the
  // model can ground broad/orientation questions.
  let overview: ProjectOverview | null = null

  // 1a) Pinned entities from the user's [entity:UUID] citations always go
  //     in first — they're the most likely thing the user wants summarised.
  //     We strip metadata.diff because the per-file content is also coming
  //     in as pinned chunks below; duplicating it would inflate the prompt
  //     and bias the model to cite the entity (◆) instead of the chunks (↗).
  for (const pinned of ctx.pinnedEntities ?? []) {
    seenEntityIds.add(pinned.id)
    const cleanedMeta = pinned.metadata
      ? stripInlineDiff(pinned.metadata)
      : pinned.metadata
    entitiesContext.push({ ...pinned, metadata: cleanedMeta })
  }

  // 1b) Pinned chunks (those linked to pinned entities via entity_chunks).
  //     These give the model citable [chunk:UUID] anchors that resolve to
  //     the source viewer rather than the graph.
  for (const pc of ctx.pinnedChunks ?? []) {
    if (seenChunkIds.has(pc.id)) continue
    seenChunkIds.add(pc.id)
    chunks.push({
      id: pc.id,
      text: pc.text,
      filePath: pc.filePath,
      startLine: pc.startLine,
      endLine: pc.endLine,
    })
  }

  for (const item of params.context.flat(2)) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    // get_project_overview envelope: detected by the presence of
    // entrypoints + coreAbstractions + stats keys together (other
    // envelopes carry one or two but never this combo).
    if (
      Array.isArray(obj.entrypoints)
      && Array.isArray(obj.coreAbstractions)
      && obj.stats && typeof obj.stats === 'object'
    ) {
      overview = obj as unknown as ProjectOverview
      // Lift abstraction entities into the entity context so the model
      // can cite [entity:UUID] when summarising what depends on what.
      for (const e of overview.coreAbstractions ?? []) {
        if (seenEntityIds.has(e.id)) continue
        seenEntityIds.add(e.id)
        entitiesContext.push({
          id: e.id,
          name: e.name,
          type: e.type,
          description: e.description,
          qualifiedName: e.qualifiedName,
          metadata: null,
          filePath: e.filePath,
          startLine: null,
          endLine: null,
          language: null,
          signature: null,
        })
      }
      continue
    }
    // list_issues envelope { issues, relatedChunks }: collect issues
    // for prompt injection AND lift linked code into the main entity /
    // chunk context so [chunk:UUID] / [entity:UUID] citations work.
    if (Array.isArray(obj.issues) && obj.issues.every((it) => it && typeof it === 'object' && typeof (it as { number?: unknown }).number === 'number')) {
      for (const it of obj.issues as IssueResult[]) {
        issueResults.push(it)
        for (const e of it.relatedEntities ?? []) {
          if (seenEntityIds.has(e.entityId)) continue
          seenEntityIds.add(e.entityId)
          entitiesContext.push({
            id: e.entityId,
            name: e.name,
            type: e.type,
            description: e.description,
            qualifiedName: e.qualifiedName,
            metadata: null,
            filePath: e.filePath,
            startLine: null,
            endLine: null,
            language: null,
            signature: null,
          })
        }
      }
      const relatedChunks = (obj.relatedChunks as LinkedChunk[] | undefined) ?? []
      for (const c of relatedChunks) {
        if (seenChunkIds.has(c.id)) continue
        seenChunkIds.add(c.id)
        chunks.push({
          id: c.id,
          text: c.text,
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
        })
      }
      continue
    }
    // Walkthrough envelope { entities, mermaid }: unwrap entities and
    // collect the mermaid block for later prompt injection. Skip the
    // chunk/entity detection below for this object — it's a container,
    // not a leaf.
    if (Array.isArray(obj.entities) && typeof obj.mermaid === 'string') {
      if (obj.mermaid.trim().length > 0) mermaidBlocks.push(obj.mermaid)
      for (const inner of obj.entities) {
        if (!inner || typeof inner !== 'object') continue
        const e = inner as Record<string, unknown>
        if (typeof e.name !== 'string' || typeof e.id !== 'string') continue
        if (seenEntityIds.has(e.id as string)) continue
        seenEntityIds.add(e.id as string)
        entitiesContext.push({
          id: e.id as string,
          name: e.name as string,
          type: (e.type as string | undefined) ?? 'entity',
          description: (e.description as string | null | undefined) ?? null,
          qualifiedName: (e.qualifiedName as string | null | undefined) ?? null,
          metadata: (e.metadata as Record<string, unknown> | null | undefined) ?? null,
          filePath: (e.filePath as string | null | undefined) ?? null,
          startLine: (e.startLine as number | null | undefined) ?? null,
          endLine: (e.endLine as number | null | undefined) ?? null,
          language: (e.language as string | null | undefined) ?? null,
          signature: (e.signature as string | null | undefined) ?? null,
        })
      }
      continue
    }
    // Chunks come back with either `id` (search_docs, vector_search_chunks,
    // retrieve_code_chunks) or `chunkId` (hybrid_search) — accept both.
    const chunkId =
      typeof obj.id === 'string'
        ? obj.id
        : typeof obj.chunkId === 'string'
          ? obj.chunkId
          : null
    if (typeof obj.text === 'string' && chunkId) {
      if (seenChunkIds.has(chunkId)) continue
      seenChunkIds.add(chunkId)
      chunks.push({
        id: chunkId,
        text: obj.text as string,
        filePath: (obj.filePath as string | null) ?? null,
        startLine: (obj.startLine as number | null) ?? null,
        endLine: (obj.endLine as number | null) ?? null,
      })
    } else if (typeof obj.name === 'string' && typeof obj.id === 'string' && typeof obj.type === 'string') {
      const id = obj.id as string
      if (seenEntityIds.has(id)) continue
      seenEntityIds.add(id)
      entitiesContext.push({
        id,
        name: obj.name as string,
        type: obj.type as string,
        description: (obj.description as string | null) ?? null,
        qualifiedName: (obj.qualifiedName as string | null) ?? null,
        metadata: (obj.metadata as Record<string, unknown> | null) ?? null,
        filePath: (obj.filePath as string | null) ?? null,
        startLine: (obj.startLine as number | null) ?? null,
        endLine: (obj.endLine as number | null) ?? null,
        language: (obj.language as string | null) ?? null,
        signature: (obj.signature as string | null) ?? null,
      })
    }
  }

  // Safety net: if the planner produced no chunks at all, fall back to
  // hybrid_search on the question itself so the model always has something
  // concrete to ground in. Workspace meta below covers the "no chunks AND
  // no entities" case for broad questions.
  if (chunks.length === 0) {
    try {
      const results = await hybridSearch(ctx.db, ctx.embeddings, {
        workspaceId: ctx.workspaceId,
        query: params.question,
        limit: 8,
      })
      for (const r of results) {
        chunks.push({
          id: r.chunkId,
          text: r.text,
          filePath: r.filePath,
          startLine: r.startLine,
          endLine: r.endLine,
        })
      }
    } catch {
      // ignore — answer still works with workspace meta only
    }
  }

  for await (const evt of answer(ctx.llm, {
    question: params.question,
    chunks,
    entities: entitiesContext,
    style: params.style,
    workspace: ctx.workspace,
    responseLocale: ctx.responseLocale,
    mermaidDiagrams: mermaidBlocks,
    issues: issueResults,
    overview,
    userPastedDiff: ctx.userPastedDiff,
    history: ctx.history,
  })) {
    yield evt
  }
}

/**
 * Drop the inline `diff` field (and `diffTruncated` flag) from a commit's
 * metadata when we're also passing the same content as separate chunks.
 * Keeps message/sha/author/date/filesChanged so the entity card still has
 * its identifying info.
 */
function stripInlineDiff(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  if (!('diff' in metadata)) return metadata
  const { diff, diffTruncated, ...rest } = metadata
  void diff
  void diffTruncated
  return rest
}

// ---------- Operator registry ----------
// OperatorName is the single source of truth from shared/schemas/plan.ts
// (the Zod enum that validates LLM-emitted plans). Re-exported here so
// callers only need one import. Adding an operator: name → OPERATOR_NAMES
// → TS forces an entry in OPERATORS below + in agentic.ts TOOL_DEFS
// (also a Record keyed by name). The catalogue prose in planner.ts is
// the only place TS can't enforce — keep it in sync manually.
export type { OperatorName } from '#shared/schemas/plan'

import type { OperatorName } from '#shared/schemas/plan'

export const OPERATORS: Record<
  OperatorName,
  (params: never, ctx: OperatorContext) => Promise<unknown> | AsyncGenerator<unknown>
> = {
  find_symbol: findSymbol as never,
  find_file: findFile as never,
  get_callers: getCallers as never,
  get_callees: getCallees as never,
  get_dependencies: getDependencies as never,
  get_dependents: getDependents as never,
  find_implementations: findImplementations as never,
  git_history: gitHistory as never,
  find_by_concept: findByConcept as never,
  vector_search_chunks: vectorSearchChunks as never,
  hybrid_search: hybridSearchOp as never,
  search_docs: searchDocs as never,
  retrieve_code_chunks: retrieveCodeChunks as never,
  get_summary: getSummary as never,
  walkthrough: walkthrough as never,
  list_issues: listIssues as never,
  list_prs: listPrs as never,
  find_similar_issues: findSimilarIssues as never,
  find_prs_for_issue: findPrsForIssue as never,
  find_resolution: findResolution as never,
  get_project_overview: getProjectOverviewOp as never,
  read_file: readFileOp as never,
  tests_for: testsFor as never,
  list_concepts: listConcepts as never,
  web_search: webSearchOp as never,
  web_fetch: webFetchOp as never,
  propose_edit: proposeEditOp as never,
  answer: answerOp as never,
}

// ---------- AnswerOperator + provider list for KagModule ----------

@Injectable()
export class AnswerOperator implements KagOperator {
  readonly name = 'answer' as const
  execute(
    p: { question: string; context: unknown[]; style?: 'concise' | 'detailed' },
    c: OperatorContext,
  ): AsyncGenerator<AnswerStreamChunk> {
    return answerOp(p, c)
  }
}

/**
 * Every @Injectable operator class — KagModule registers each one as a
 * provider AND as a `KAG_OPERATOR` multi-provider so the registry can
 * collect them at startup.
 *
 * Order matters only for readability: registry construction throws on
 * duplicate `name` values, so collisions surface as a clear boot error.
 */
export const KAG_OPERATOR_CLASSES = [
  FindSymbolOperator,
  FindFileOperator,
  GetCallersOperator,
  GetCalleesOperator,
  GetDependenciesOperator,
  GetDependentsOperator,
  FindImplementationsOperator,
  GitHistoryOperator,
  FindByConceptOperator,
  VectorSearchChunksOperator,
  HybridSearchOperator,
  SearchDocsOperator,
  RetrieveCodeChunksOperator,
  GetSummaryOperator,
  WalkthroughOperator,
  ListIssuesOperator,
  ListPrsOperator,
  FindSimilarIssuesOperator,
  FindPrsForIssueOperator,
  FindResolutionOperator,
  GetProjectOverviewOperator,
  ReadFileOperator,
  TestsForOperator,
  ListConceptsOperator,
  WebSearchOperator,
  WebFetchOperator,
  ProposeEditOperator,
  AnswerOperator,
] as const
