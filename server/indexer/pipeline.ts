import type { Job } from 'bullmq'
import { readFile } from 'node:fs/promises'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { entities as entitiesTable, workspaces } from '../db/schema'
import { getLogger, withTrace } from '../lib/logger'
import {
  markWorkspaceFailed,
  markWorkspaceReady,
  setWorkspaceProgress,
} from '../services/workspace-progress'
import type {
  IndexWorkspaceJobData,
  IndexWorkspaceJobResult,
} from '../queues'
import { fetchGitHub, type FetchedSource } from './source/fetch'
import { walkRepo } from './source/walk'
import { extractGitHistory } from './git/history'
import { computeGitInsights } from './git/insights'
import { embedAllPendingChunks, embedChunks } from './embed'
import {
  createEmbeddingsProvider,
  type EmbeddingsProvider,
} from '../providers/embeddings'
import { annotateAndEmbed } from './annotate'
import { resolveEntities } from './resolution'
import { type LLMProvider } from '../providers/llm'
import { getTypeScriptParser } from './parsers/typescript'
import { getPythonParser } from './parsers/python'
import { getGoParser } from './parsers/go'
import { chunkCode, chunkMarkdown, type CodeChunk } from './chunking/chunker'
import {
  clearWorkspaceGraph,
  insertChunks,
  insertEntities,
  insertRelations,
  linkEntityChunks,
  persistGitHistory,
} from './persist'
import type {
  ParsedEntity,
  ParsedRelation,
  ParserInput,
} from './parsers/types'

const log = getLogger().child({ component: 'indexer/pipeline' })

export interface PipelineDeps {
  embeddings?: EmbeddingsProvider
  llm?: LLMProvider
  /** Skip the LLM annotation phase entirely (useful for tests / cost-control). */
  skipAnnotation?: boolean
  /** Hard cap on annotated entities (forwarded to annotateAndEmbed). */
  maxAnnotated?: number
}

export async function runIndexPipeline(
  db: Database,
  job: Job<IndexWorkspaceJobData, IndexWorkspaceJobResult>,
  deps: PipelineDeps = {},
): Promise<IndexWorkspaceJobResult> {
  const { workspaceId, userId } = job.data
  return withTrace({ workspaceId, userId, jobId: job.id }, async () => {
    const start = Date.now()
    log.info('pipeline started')

    let source: FetchedSource | null = null

    try {
      // 1. Look up workspace + source URL.
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
      if (!ws) throw new Error(`workspace ${workspaceId} not found`)

      // 2. Clone / extract source.
      await setWorkspaceProgress(db, workspaceId, {
        phase: 'cloning',
        percent: 5,
        message: 'Fetching source…',
      })
      if (ws.sourceType === 'github' && ws.sourceUrl) {
        source = await fetchGitHub(ws.sourceUrl)
      } else {
        throw new Error(
          `unsupported source type ${ws.sourceType} — only github implemented in phase 2`,
        )
      }

      // Persist HEAD info.
      if (source.headSha) {
        await db
          .update(workspaces)
          .set({
            indexedCommitSha: source.headSha,
            defaultBranch: source.defaultBranch,
          })
          .where(eq(workspaces.id, workspaceId))
      }

      // 3. Walk repo + detect languages.
      await setWorkspaceProgress(db, workspaceId, {
        phase: 'parsing',
        percent: 20,
        message: 'Walking files…',
      })
      const walked = await walkRepo(source.workdir)
      await db
        .update(workspaces)
        .set({ languages: walked.languages })
        .where(eq(workspaces.id, workspaceId))

      // 4. Clear previous graph for this workspace (idempotent rerun).
      await clearWorkspaceGraph(db, workspaceId)

      // 5. Parse all source files in parallel (capped concurrency).
      await setWorkspaceProgress(db, workspaceId, {
        phase: 'parsing',
        percent: 35,
        message: `Parsing ${walked.files.length} files…`,
      })

      const allEntities: ParsedEntity[] = []
      const allRelations: ParsedRelation[] = []
      const allChunks: CodeChunk[] = []
      const warnings: string[] = []

      const parsable = walked.files.filter(
        (f) => f.language !== null && f.sizeBytes > 0,
      )

      const CONCURRENCY = 4
      let cursor = 0
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
          const i = cursor++
          if (i >= parsable.length) break
          const file = parsable[i]
          if (!file?.language) continue
          try {
            const fileText = await readFile(file.absPath, 'utf-8')
            const parser = parserFor(file.language)
            if (!parser) continue
            const input: ParserInput = {
              relPath: file.relPath,
              absPath: file.absPath,
              source: fileText,
              language: file.language,
            }
            const result = await parser.parse(input)
            allEntities.push(...result.entities)
            allRelations.push(...result.relations)
            warnings.push(...result.warnings.map((w) => `${file.relPath}: ${w}`))

            // Chunk in-line.
            const codeChunks = chunkCode(
              file.relPath,
              fileText,
              result,
              file.language,
            )
            allChunks.push(...codeChunks)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            warnings.push(`${file.relPath}: ${msg}`)
          }
        }
      })
      await Promise.all(workers)

      // 5b. Markdown / doc chunks (no AST extraction in phase 2).
      const mdFiles = walked.files.filter((f) =>
        /\.(md|mdx)$/i.test(f.relPath),
      )
      for (const md of mdFiles) {
        try {
          const text = await readFile(md.absPath, 'utf-8')
          allChunks.push(...chunkMarkdown(md.relPath, text))
          allEntities.push({
            qualifiedName: md.relPath,
            name: md.relPath.split('/').pop() ?? md.relPath,
            type: 'document',
            language: 'typescript', // docs share no language — pick a sentinel; resolution ignores it
            filePath: md.relPath,
            startLine: 1,
            endLine: text.split('\n').length,
          })
        } catch {
          /* skip unreadable docs */
        }
      }

      // 6. Persist entities.
      await setWorkspaceProgress(db, workspaceId, {
        phase: 'extracting',
        percent: 55,
        message: `Persisting ${allEntities.length} entities…`,
      })
      const idMap = await insertEntities(db, workspaceId, allEntities)

      // 7. Build short-name index for cross-file call resolution.
      const nameIndex = new Map<string, string[]>()
      for (const e of allEntities) {
        const idsForName = nameIndex.get(e.name.toLowerCase()) ?? []
        const id = idMap.get(e.qualifiedName)
        if (id) {
          idsForName.push(id)
          nameIndex.set(e.name.toLowerCase(), idsForName)
        }
      }

      // 8. Persist relations.
      await setWorkspaceProgress(db, workspaceId, {
        phase: 'extracting',
        percent: 70,
        message: `Persisting ${allRelations.length} relations…`,
      })
      const relCount = await insertRelations(db, workspaceId, allRelations, idMap, nameIndex)

      // 9. Persist chunks + mutual index.
      await setWorkspaceProgress(db, workspaceId, {
        phase: 'embedding',
        percent: 80,
        message: `Saving ${allChunks.length} chunks…`,
      })
      const { ids: chunkIds, chunkByQualified } = await insertChunks(
        db,
        workspaceId,
        allChunks,
      )
      await linkEntityChunks(db, idMap, chunkByQualified)

      // 9b. Embed chunks.
      const embeddings = deps.embeddings ?? createEmbeddingsProvider()
      await setWorkspaceProgress(db, workspaceId, {
        phase: 'embedding',
        percent: 85,
        message: `Embedding ${chunkIds.length} chunks…`,
      })
      const embeddedCount = await embedChunks(
        db,
        workspaceId,
        chunkIds,
        embeddings,
        async (done, total) => {
          await setWorkspaceProgress(db, workspaceId, {
            phase: 'embedding',
            percent: 85 + Math.round((done / total) * 5),
            message: `Embedded ${done}/${total} chunks`,
          })
        },
      )

      // 9c. LLM semantic annotation (phase 4).
      let annotationStats = { annotated: 0, conceptsCreated: 0, patternsCreated: 0 }
      let resolutionStats = { merged: 0, flagged: 0 }
      if (!deps.skipAnnotation && deps.llm) {
        await setWorkspaceProgress(db, workspaceId, {
          phase: 'extracting',
          percent: 92,
          message: 'Running LLM semantic annotation…',
        })
        // Throttle progress writes to ~once per 5 entities or 1s so we don't
        // hammer the DB on a fast run.
        let lastProgressWrite = 0
        annotationStats = await annotateAndEmbed(
          db,
          workspaceId,
          deps.llm,
          embeddings,
          { maxEntities: deps.maxAnnotated },
          async (done, total) => {
            const now = Date.now()
            if (done < total && now - lastProgressWrite < 1000 && done % 5 !== 0) {
              return
            }
            lastProgressWrite = now
            await setWorkspaceProgress(db, workspaceId, {
              phase: 'extracting',
              percent: 92 + Math.round((done / total) * 3),
              message: `Annotating ${done}/${total} entities (LLM)…`,
            })
          },
        )
        await setWorkspaceProgress(db, workspaceId, {
          phase: 'extracting',
          percent: 95,
          message: 'Deduplicating concepts and patterns…',
        })
        resolutionStats = await resolveEntities(db, workspaceId)
      }

      // 10. Git history.
      await setWorkspaceProgress(db, workspaceId, {
        phase: 'embedding',
        percent: 90,
        message: 'Reading git history…',
      })
      const fileIdByPath = new Map<string, string>()
      for (const e of allEntities) {
        if (e.type === 'file') {
          const id = idMap.get(e.qualifiedName)
          if (id) fileIdByPath.set(e.filePath, id)
        }
      }
      const history = await extractGitHistory(source.workdir)
      const commitCount = await persistGitHistory(
        db,
        workspaceId,
        history,
        fileIdByPath,
      )

      // Diff chunks were created inside persistGitHistory but skipped the
      // earlier embed step. Catch them up here so hybrid_search and
      // retrieve_code_chunks can use them.
      const diffEmbedded = await embedAllPendingChunks(
        db,
        workspaceId,
        embeddings,
      )
      if (diffEmbedded > 0) {
        await setWorkspaceProgress(db, workspaceId, {
          phase: 'embedding',
          percent: 96,
          message: `Embedded ${diffEmbedded} diff chunk(s)`,
        })
      }

      // 10b. Annotate file entities with hotness in their metadata.
      for (const [path, hits] of history.hotness) {
        const id = fileIdByPath.get(path)
        if (!id) continue
        await db
          .update(entitiesTable)
          .set({ metadata: { hotness: hits } })
          .where(eq(entitiesTable.id, id))
      }

      // 10c. Aggregate git insights and stash on workspaces.stats so the
      // workspace page can render maintainer/activity/quality cards
      // without re-walking commits.
      const gitInsights = computeGitInsights(history)
      await db
        .update(workspaces)
        .set({
          stats: sql`coalesce(${workspaces.stats}, '{}'::jsonb) || ${JSON.stringify({ gitInsights })}::jsonb`,
        })
        .where(eq(workspaces.id, workspaceId))

      // 11. Done.
      await markWorkspaceReady(db, workspaceId, {
        files: walked.files.length,
        entities: allEntities.length,
        relations: relCount,
        chunks: chunkIds.length,
        embeddedChunks: embeddedCount,
        commits: commitCount,
        warnings: warnings.length,
        annotated: annotationStats.annotated,
        concepts: annotationStats.conceptsCreated,
        patterns: annotationStats.patternsCreated,
        mergedDuplicates: resolutionStats.merged,
        flaggedDuplicates: resolutionStats.flagged,
        tokensSpent: 0,
      })

      const durationMs = Date.now() - start
      log.info({ durationMs, entities: allEntities.length }, 'pipeline ready')
      return {
        ok: true,
        filesProcessed: walked.files.length,
        durationMs,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // postgres-js wraps the driver error and exposes its detail via `.cause`
      // (PostgresError with .code / .detail / .table fields). Surface what
      // we can so the operator log shows the actual root cause.
      const cause = err instanceof Error ? (err.cause as unknown) : undefined
      const causeFields =
        cause && typeof cause === 'object'
          ? {
              causeMessage: (cause as { message?: string }).message,
              causeCode: (cause as { code?: string }).code,
              causeDetail: (cause as { detail?: string }).detail,
              causeTable: (cause as { table_name?: string }).table_name,
            }
          : {}
      log.error({ err: msg, ...causeFields }, 'pipeline failed')
      const failureMessage = causeFields.causeMessage
        ? `${msg} — ${causeFields.causeMessage}`
        : msg
      await markWorkspaceFailed(db, workspaceId, failureMessage)
      throw err
    } finally {
      if (source) await source.cleanup()
    }
  })
}

function parserFor(language: string) {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return getTypeScriptParser()
    case 'python':
      return getPythonParser()
    case 'go':
      return getGoParser()
    default:
      return null
  }
}
