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

      // 5b'. Project manifests — package.json / Makefile / Dockerfile / etc.
      // These aren't AST-parseable and aren't markdown, so without this
      // step they never reach the chunks table. The onboarding + setup
      // endpoints rely on chunks.file_path / chunks.text to read
      // pkg.scripts, Makefile targets, the README's Quick Start, etc.
      // 256KB cap per file is enough to cover real-world manifests
      // without bloating the chunk store.
      const MANIFEST_RE = /(^|\/)(package\.json|pyproject\.toml|Makefile|Dockerfile|go\.mod|Cargo\.toml|docker-compose(\..+)?\.ya?ml)$/i
      const MANIFEST_MAX_BYTES = 256 * 1024
      const manifestFiles = walked.files.filter(
        (f) => MANIFEST_RE.test(f.relPath) && f.sizeBytes > 0 && f.sizeBytes <= MANIFEST_MAX_BYTES,
      )
      for (const m of manifestFiles) {
        try {
          const text = await readFile(m.absPath, 'utf-8')
          const lineCount = text.split('\n').length
          allChunks.push({
            filePath: m.relPath,
            startLine: 1,
            endLine: lineCount,
            text,
            sourceType: 'config',
            metadata: { language: m.language ?? 'unknown' },
          })
        } catch {
          /* skip unreadable manifest */
        }
      }

      // 5b''. Fallback whole-file chunks for everything else that the
      // parsers + markdown + manifests passes missed. Covers tsconfig
      // /*.json/yaml/toml/sql/css/sh/files-without-extension/etc. —
      // anything that's text-shaped and under the cap. Without this,
      // hybrid_search and the new read_file operator have nothing to
      // surface for a huge swath of the project.
      const FALLBACK_MAX_BYTES = 128 * 1024
      // Skip patterns: stuff we explicitly never want as fallback
      // (already covered by other passes, or binary-shaped).
      const FALLBACK_SKIP_RE = /\.(?:md|mdx|ts|tsx|js|jsx|mts|cts|mjs|cjs|vue|py|pyi|go|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|pdf|zip|tar|gz|bin)$/i
      const seenChunkPaths = new Set<string>(allChunks.map((c) => c.filePath))
      const fallbackFiles = walked.files.filter((f) => {
        if (!f.relPath || f.sizeBytes === 0 || f.sizeBytes > FALLBACK_MAX_BYTES) return false
        if (seenChunkPaths.has(f.relPath)) return false
        if (FALLBACK_SKIP_RE.test(f.relPath)) return false
        if (MANIFEST_RE.test(f.relPath)) return false
        return true
      })
      for (const f of fallbackFiles) {
        try {
          const text = await readFile(f.absPath, 'utf-8')
          // Belt-and-braces binary sniff: drop the file if the read
          // returned mostly non-printable bytes.
          if (looksBinary(text)) continue
          const lineCount = text.split('\n').length
          allChunks.push({
            filePath: f.relPath,
            startLine: 1,
            endLine: lineCount,
            text,
            sourceType: 'code',
            metadata: { language: f.language ?? 'unknown' },
          })
        } catch {
          /* skip unreadable */
        }
      }

      // 5c. Derive `tested_by` relations: for every test-file entity, look at
      // its outgoing `imports` relations and emit a tested_by edge from each
      // top-level entity defined in the imported file back to the test
      // file. The resolver is approximate (it matches by file path prefix,
      // not by imported symbol name), which is intentional — author intent
      // "this test covers module X" usually maps to "this test exercises
      // all top-level entities in module X".
      deriveTestedByRelations(allEntities, allRelations)

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

      // 11b. Aggregate git insights and merge onto workspaces.stats so the
      // workspace page can render maintainer/activity/quality cards without
      // re-walking commits. Done AFTER markWorkspaceReady because that call
      // sets `stats` to a plain object and would otherwise overwrite us.
      const gitInsights = computeGitInsights(history)
      await db
        .update(workspaces)
        .set({
          stats: sql`coalesce(${workspaces.stats}, '{}'::jsonb) || ${JSON.stringify({ gitInsights })}::jsonb`,
        })
        .where(eq(workspaces.id, workspaceId))

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

/**
 * Heuristic resolver: for every test-file entity, attach `tested_by`
 * edges from the entities of the files it imports. We don't try to
 * follow each imported symbol — that would need real module resolution
 * and re-export tracing — but "the test imports module X" is enough
 * signal in practice. Mutates `allRelations` in place.
 */
/**
 * Cheap binary sniff: count printable / whitespace bytes in the first
 * 4KB. If less than 90% are printable, treat the file as binary and
 * skip it. Cheaper and more reliable than relying on file extensions
 * alone (some binary files have ambiguous extensions, some text files
 * have none).
 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4096)
  if (sample.length === 0) return true
  let printable = 0
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    // Tab, LF, CR are whitespace; anything ≥ 32 except DEL (127) is printable.
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      printable += 1
    }
  }
  return printable / sample.length < 0.9
}

function deriveTestedByRelations(
  allEntities: ParsedEntity[],
  allRelations: ParsedRelation[],
): void {
  const testFiles = new Set<string>()
  for (const e of allEntities) {
    if (e.type === 'test') testFiles.add(e.qualifiedName)
  }
  if (testFiles.size === 0) return

  // Build a quick index of relPath → top-level entities in that file.
  // Top-level = the entity itself sits in that file AND is not a method
  // (we filter out anything with `::` after the first segment so we don't
  // double-up class methods into the relation set — the class itself is
  // enough).
  const topLevelByFile = new Map<string, ParsedEntity[]>()
  for (const e of allEntities) {
    if (e.type === 'file' || e.type === 'test' || e.type === 'document') continue
    // qualifiedName looks like `path/to/file.ts::Symbol` or
    // `path/to/file.ts::Class::method`. Keep only the first `::Symbol` form.
    const segments = e.qualifiedName.split('::')
    if (segments.length !== 2) continue
    const arr = topLevelByFile.get(e.filePath) ?? []
    arr.push(e)
    topLevelByFile.set(e.filePath, arr)
  }

  // Common source extensions we may need to try when a relative import
  // omits one (`./foo` → `src/foo.ts`).
  const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']

  for (const rel of allRelations) {
    if (rel.type !== 'imports') continue
    if (!testFiles.has(rel.fromQualified)) continue
    // toQualified for relative imports is the resolved path WITHOUT extension.
    // External imports look like raw module names ("zod") — skip them.
    if (rel.toQualified.includes(':') || !rel.toQualified.includes('/')) continue

    let importedFile: string | null = null
    if (topLevelByFile.has(rel.toQualified)) {
      importedFile = rel.toQualified
    } else {
      for (const ext of EXTS) {
        if (topLevelByFile.has(rel.toQualified + ext)) {
          importedFile = rel.toQualified + ext
          break
        }
        const indexPath = `${rel.toQualified}/index${ext}`
        if (topLevelByFile.has(indexPath)) {
          importedFile = indexPath
          break
        }
      }
    }
    if (!importedFile) continue
    const targets = topLevelByFile.get(importedFile) ?? []
    for (const target of targets) {
      allRelations.push({
        fromQualified: target.qualifiedName,
        toQualified: rel.fromQualified,
        type: 'tested_by',
      })
    }
  }
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
