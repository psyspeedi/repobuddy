import type { Job } from 'bullmq'
import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
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

export async function runIndexPipeline(
  db: Database,
  job: Job<IndexWorkspaceJobData, IndexWorkspaceJobResult>,
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

      // 10b. Annotate file entities with hotness in their metadata.
      for (const [path, hits] of history.hotness) {
        const id = fileIdByPath.get(path)
        if (!id) continue
        await db
          .update(entitiesTable)
          .set({ metadata: { hotness: hits } })
          .where(eq(entitiesTable.id, id))
      }

      // 11. Done.
      await markWorkspaceReady(db, workspaceId, {
        files: walked.files.length,
        entities: allEntities.length,
        relations: relCount,
        chunks: chunkIds.length,
        commits: commitCount,
        warnings: warnings.length,
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
      log.error({ err: msg }, 'pipeline failed')
      await markWorkspaceFailed(db, workspaceId, msg)
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
