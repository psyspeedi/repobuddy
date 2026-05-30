# Indexing pipeline

How a GitHub URL becomes a queryable knowledge graph.

## The shape of the work

When a user creates a workspace, [`server/api/workspaces/index.post.ts`](../server/api/workspaces/index.post.ts) inserts a row in `status='pending'` and pushes a job into the BullMQ `index-workspace` queue. The worker (a separate Node process built by [`server/workers/build.ts`](../server/workers/build.ts)) consumes the queue. Each phase emits SSE progress events the browser subscribes to so the create-workspace page can render a live progress bar.

```mermaid
flowchart LR
    A[fetch] --> B[walk]
    B --> C[parse + AST chunk]
    C --> D[manifest chunk]
    D --> E[fallback whole-file chunk]
    E --> F[markdown chunk]
    F --> G[derive tested_by]
    G --> H[persist entities + relations]
    H --> I[chunk embeddings]
    I --> J[mutual entity_chunks index]
    J --> K[LLM annotation]
    K --> L[entity-description embeddings]
    L --> M[entity resolution dedup]
    M --> N[git history extract]
    N --> O[PR history fetch]
    O --> P[markWorkspaceReady]
    P --> Q[git insights aggregate]
```

Full source: [`server/indexer/pipeline.ts`](../server/indexer/pipeline.ts).

## Phase-by-phase

### 1. Fetch

[`server/indexer/source/fetch.ts`](../server/indexer/source/fetch.ts) does a `simple-git` shallow clone (`depth=200` — enough history for hotness + PR derivation, not enough to download multi-GB repos). Falls back to a ZIP upload path for the upload flow. Both write into a `mkdtemp` directory keyed by `repobuddy-clone-` so cleanup is straightforward.

### 2. Walk

[`server/indexer/source/walk.ts`](../server/indexer/source/walk.ts) walks the working tree with a stack of `.gitignore` patterns (parent-inherited, child-augmented), applies a hard-exclude list (`node_modules`, `vendor`, `.git`, `dist`, `build`, `.next`, `.nuxt`, etc.), and emits per-file `{ absPath, relPath, language, sizeBytes }` records. 1 MB hard cap per file.

Language detection: extension map (`.ts → typescript`, `.go → go`, ...) plus a manifest-name map (`package.json`, `go.mod`). Files without a recognised language stay `language=null` and skip the AST step.

### 3. Parse + AST-aware chunking

Per-language parsers under [`server/indexer/parsers/`](../server/indexer/parsers/):

- TypeScript / JavaScript / `.vue` — `ts-morph` (full TS compiler, real types and inheritance)
- Python — `web-tree-sitter` with the Python grammar WASM
- Go — `web-tree-sitter` with the Go grammar WASM

Each parser returns `{ entities, relations, warnings }`. Top-level entities (classes, functions, types, components, routes, tests) carry `qualifiedName`, file path, line range, and language. Relations include `imports`, `calls`, `extends`, `implements`, `uses_type`, `defined_in`, `contained_in`, `renders`, `handles`, `tested_by` (derived in phase 7).

Chunker ([`server/indexer/chunking/chunker.ts`](../server/indexer/chunking/chunker.ts)) takes the parser result and emits code chunks:

- File < 150 lines → one whole-file chunk
- Otherwise → one chunk per top-level entity, sliced by `start_line` → `end_line`
- Methods within a class are NOT emitted as separate chunks (they'd duplicate the class) — except when the class itself is > 200 lines, in which case it's split at method boundaries
- Anything under `examples/`, `sample/`, `demo/`, `sandbox/`, `playground/` is tagged `sourceType: 'example'` so the retrieval layer can prefer it for "how do I use X" questions

### 4. Manifest chunks

[`server/indexer/pipeline.ts`](../server/indexer/pipeline.ts) step 5b' reads canonical project manifests as whole-file chunks (`package.json`, `pyproject.toml`, `Makefile`, `Dockerfile`, `go.mod`, `Cargo.toml`, `docker-compose*.yml`). 256 KB cap each. Tagged `sourceType: 'config'`.

Without this step the Tour/onboarding endpoints can't find `tsconfig.json` etc. — manifests don't get the AST treatment so they'd never reach `chunks` table.

### 5. Fallback whole-file chunks

Step 5b'' catches everything text-shaped < 128 KB the prior passes missed. Skip list excludes AST-parseable extensions (already chunked) plus binary-shaped extensions. Belt-and-braces binary sniff: drop the file if < 90% of the first 4 KB is printable.

This step is why `read_file({path: 'tsconfig.json'})` works in chat — the chunk exists.

### 6. Markdown chunks

[`server/indexer/chunking/chunker.ts:chunkMarkdown`](../server/indexer/chunking/chunker.ts) splits `.md`/`.mdx` at H1-H3 headings. Each section becomes a chunk with `sourceType: 'doc'` (or `'example'` if under an examples/ subtree).

### 7. Derive `tested_by` relations

[`server/indexer/pipeline.ts:deriveTestedByRelations`](../server/indexer/pipeline.ts) walks all `imports` relations originating from test-file entities. For each imported module, it emits a `tested_by` edge from every top-level entity defined in that module back to the test file. The resolver is approximate (path-prefix match, not symbol-level) but matches author intent: "this test exercises module X" generally means it covers most things in X.

This is what powers the `tests_for(entity)` operator.

### 8. Persist entities + relations

Drizzle inserts in batches. Entities use `(workspace_id, qualified_name)` unique constraint with `ON CONFLICT DO NOTHING` so re-runs are idempotent. Relations don't have a uniqueness constraint by design — duplicate edges with different `evidenceQuote` values are valuable.

Re-index pre-deletes the workspace's entities + relations + chunks (cascade truncates `entity_chunks` and `chat_sessions`) before re-running. This is the right tradeoff vs. trying to merge — the indexer is fast enough that "throw away and rebuild" beats reconciliation.

### 9. Chunk embeddings

[`server/providers/embeddings.ts`](../server/providers/embeddings.ts) batches chunks into the OpenAI embeddings endpoint (`text-embedding-3-small`, 1536-dim). Token-bucket rate limit + exponential backoff on 429s. The hard cap per embedding input is 8192 tokens — text is pre-tokenised with the cl100k tokeniser and split if longer.

Cost guardrail: each batch checks the running cost via `server/lib/cost-log.ts` and aborts the workspace if `LLM_BUDGET_USD_PER_INDEX` would be exceeded.

### 10. Mutual `entity_chunks` index

`entity_chunks(entity_id, chunk_id)` is the many-to-many bridge that makes citations symmetric:

- From a `[chunk:UUID]` citation the source viewer can find which entity the chunk belongs to.
- From a `[entity:UUID]` citation the answer operator can pre-load that entity's chunks as `pinnedChunks`.

The population rule is "an entity is linked to every chunk that overlaps its line range" — implemented as a straightforward SQL join over `(file_path, [start_line, end_line])` ranges.

### 11. LLM annotation

[`server/indexer/annotate.ts`](../server/indexer/annotate.ts) sends batches of entities to `gpt-4o-mini` with a Zod schema requiring `{ description, confidence, concepts: [], patterns: [], relations: [] }`. The annotator can also emit new concept / pattern entities and relations (e.g. "this function follows the Repository pattern" creates a `pattern` entity + `follows_pattern` relation).

This is the most expensive phase by far — usually 60-80% of the indexing budget. The cost estimator runs first and can abort or warn before any tokens are spent.

### 12. Entity-description embeddings

The descriptions written by step 11 get their own embedding pass. These vectors power `find_by_concept` semantic search over entity descriptions ("where is discount logic implemented" matches an entity whose annotation talks about discounts, regardless of the function name).

### 13. Entity resolution

[`server/indexer/resolve.ts`](../server/indexer/resolve.ts) deduplicates near-identical entities:

1. Group entities by `normalized_name` (lowercased, suffix-stripped).
2. For groups with > 1 member, compute pairwise cosine similarity on their description embeddings.
3. Pairs with similarity ≥ 0.9 are merged via a `merge_entities()` operation that re-points all incoming/outgoing relations to a canonical row and deletes the duplicate.
4. Pairs in 0.75-0.9 are flagged for human review (logged, not blocking).

Without this step, every overloaded method, every `cleanUp` / `cleanup` / `Cleanup` variant, and every re-export of the same symbol shows up as a separate node and the graph becomes noise.

### 14. Git history

[`server/indexer/git-history.ts`](../server/indexer/git-history.ts) walks `git log` via `simple-git` and emits:

- One `commit` entity per commit (metadata: sha, author, date, message, files changed, full diff)
- One `person` entity per unique `(name, email)` pair
- `authored(commit→person)` and `modified_by(file→commit)` relations
- A `metadata.hotness` field on each `file` entity = count of commits touching it in the last 90 days

Hotness is what powers the treemap's "Hotness" preset and the good-first-issue-zone scoring (`hotness === 0` is a stability signal).

### 15. PR history

[`server/indexer/pr-history.ts`](../server/indexer/pr-history.ts) does paginated Octokit calls for the 200 most recent merged PRs. For each, regex-extracts `fixes #N` / `closes #N` / `resolves #N` references from the body and stores them in `metadata.referencedIssues`. PRs are persisted as `pull_request` entities.

This is what the `find_prs_for_issue` operator queries — `metadata.referencedIssues @> [N]::jsonb` is a JSONB-containment indexed query.

### 16. Mark ready + aggregate git insights

`markWorkspaceReady` sets `status='ready'` and writes a `progress.stats` object. Immediately after, [`server/indexer/git-insights.ts`](../server/indexer/git-insights.ts) computes:

- `lastCommitAt`, `totalCommitsScanned`, `commitsLast30d`, `commitsLast90d`
- `activeMaintainers90d`, `topAuthors[]`
- `busFactor` (number of authors who collectively wrote ≥ 50% of commits — proxy for "if N people leave, the project stops")
- `fixCount` / `featCount` / `fixVsFeatRatio` (from conventional-commit prefixes)
- `breakingChangesLast90d`
- `commitFrequencyByMonth[]`

These power the git insights panel at the bottom of `/w/[id]` and the architecture-mermaid generation in the Tour overview.

## Failure handling

Every phase is wrapped:

```ts
try {
  await phaseFunction()
} catch (err) {
  await setWorkspaceProgress(db, workspaceId, { phase: 'failed', message: err.message })
  await db.update(workspaces).set({ status: 'failed', error: err.message }).where(...)
  throw err  // BullMQ will retry per its config
}
```

The `progress.phase` field on `workspaces` is what the SSE progress endpoint streams to the browser, so failures surface as a phase=failed message in the UI within milliseconds.

## Why this is more than a CRUD pipeline

A few decisions in here that aren't obvious:

1. **Two embedding passes** (chunks + entity descriptions). They serve different queries: chunk embeddings answer "where is this concept implemented?" via raw-text similarity; description embeddings answer "what does this function do conceptually?" via LLM-distilled summary similarity. Mixing them would dilute both.

2. **Hotness on the file entity, not derived on demand.** Computing hotness on every Tour render would be a multi-second join. Persisting it on `file.metadata.hotness` makes the treemap and good-first-issue scoring O(1) reads.

3. **PR body regex over a full GraphQL "linked issues" query.** The `fixes #N` regex catches the cases that matter and stays inside the 60 req/h anonymous Octokit budget. A GraphQL query for linked issues per PR would be both another auth layer and another round trip.

4. **The `examples/` source-type tag.** Lets the planner prefer worked examples over implementation when a user asks "how do I use X" — implementation is what they get when they ask "how does X work".

5. **`normalized_name` as the dedup grouping key, not `qualified_name`.** Two TypeScript files exporting `function clean()` from different modules deserve to merge if they're actually doing the same thing (verified by description similarity); they have different `qualified_name`s but the same `normalized_name`.

## Files to read

- Orchestration: [`server/indexer/pipeline.ts`](../server/indexer/pipeline.ts)
- Walker: [`server/indexer/source/walk.ts`](../server/indexer/source/walk.ts)
- Parsers: [`server/indexer/parsers/`](../server/indexer/parsers/)
- Chunker: [`server/indexer/chunking/chunker.ts`](../server/indexer/chunking/chunker.ts)
- Annotation: [`server/indexer/annotate.ts`](../server/indexer/annotate.ts)
- Entity resolution: [`server/indexer/resolve.ts`](../server/indexer/resolve.ts)
- Git history: [`server/indexer/git-history.ts`](../server/indexer/git-history.ts), [`server/indexer/git-insights.ts`](../server/indexer/git-insights.ts)
- PR history: [`server/indexer/pr-history.ts`](../server/indexer/pr-history.ts)
- Progress + persistence: [`server/services/workspace-progress.ts`](../server/services/workspace-progress.ts), [`server/indexer/persist.ts`](../server/indexer/persist.ts)
