# CodeGraph

AI assistant for understanding codebases via knowledge graphs.

CodeGraph indexes a public Git repository (or an uploaded ZIP) into a hybrid
knowledge graph that combines:

- **Deterministic structure** from AST: files, classes, functions, imports,
  call edges, type and inheritance relations.
- **Semantic descriptions** from an LLM: concise summaries plus extracted
  concepts and design patterns, with evidence quotes.
- **Git history**: commits, authors, and per-file hotness in the recent
  90 days.

It then answers natural-language questions by:

1. **Planning** with `gpt-4o`: a question is turned into a structured JSON
   plan of operator calls (`find_symbol`, `get_callers`, `find_by_concept`, …)
   using OpenAI structured outputs against a Zod schema.
2. **Executing** the plan on the graph: results from one step flow into the
   next via `$sN.field` references. The executor topo-sorts steps and
   records a trace.
3. **Streaming** the answer with inline `[chunk:UUID]` / `[entity:UUID]`
   citations that the UI rewrites into clickable links.
4. **Verifying** each citation maps to a real chunk; invalid markers are
   rendered with a ⚠ badge.

If planning fails twice, the system falls back to plain hybrid (vector +
BM25-style full-text) RAG so the user always gets a response.

## What works

| Area | Status |
|---|---|
| GitHub OAuth + sealed-cookie sessions | ✅ |
| Workspace creation from a public GitHub URL | ✅ |
| Live SSE indexing progress (cloning → parsing → embedding → annotation) | ✅ |
| AST extraction: TypeScript / JavaScript (`ts-morph`), Python and Go (`web-tree-sitter`) | ✅ |
| Markdown chunking + entity-aligned code chunking | ✅ |
| Git commits + authors + file hotness | ✅ |
| Vector embeddings (`text-embedding-3-small`) for chunks and entity descriptions | ✅ |
| Hybrid search: cosine + `tsvector` + Reciprocal Rank Fusion | ✅ |
| LLM semantic annotation: concepts + patterns with confidence | ✅ |
| Entity resolution: dedup by normalised name and ≥0.9 embedding cosine | ✅ |
| 14 KAG operators with $sN reference substitution and cycle detection | ✅ |
| Query planner with 4 few-shot examples and RAG fallback | ✅ |
| Streaming chat UI with markdown, code blocks, and citation badges | ✅ |
| Source viewer with Shiki syntax highlighting (jump to line range) | ✅ |
| Reasoning inspector: per-step params, status pill, duration, result summary | ✅ |
| Sigma.js graph explorer with per-type filters | ✅ |
| Production Docker Compose + Caddy reverse proxy + auto-SSL + nightly `pg_dump` | ✅ |

## Quickstart

Requirements: **Node 22+**, **pnpm 9+**, **Docker** (for Postgres+Redis).

```bash
git clone <this-repo> codegraph && cd codegraph
pnpm install
cp .env.example .env          # fill in OPENAI_API_KEY, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
openssl rand -base64 32       # → NUXT_SESSION_PASSWORD
openssl rand -hex 32          # → ENCRYPTION_KEY

pnpm db:up                    # boots Postgres (pgvector) and Redis containers
pnpm db:migrate               # creates schema + tsvector generated column

# Two terminals:
pnpm dev:web                  # Nuxt at http://localhost:3000
pnpm dev:worker               # BullMQ worker polling Redis

# Visit http://localhost:3000, sign in with GitHub, paste a small repo URL.
```

### GitHub OAuth app

Register one at https://github.com/settings/developers:
- Homepage URL: `http://localhost:3000`
- Authorization callback URL: `http://localhost:3000/auth/github`

## How it runs

```
Browser ── SSE/HTTPS ── Caddy (auto-SSL)
                          │
                          ▼
                   Nuxt 4  ──Drizzle──▶ Postgres 16 + pgvector + pg_trgm
                  (SSR + Nitro API)            ▲
                          │                    │ same image,
                          │                    │ different CMD
                          │                    │
                          ▼                    │
                       Redis ◀──── BullMQ Worker (esbuild bundle)
                                        │
                                        └────▶ OpenAI (embeddings + LLM)
```

- **Web** serves the UI, auth, REST + SSE endpoints.
- **Worker** runs the indexing pipeline (clone, parse, chunk, embed, LLM
  annotate, dedup, persist git history) so HTTP requests never block.
- Both processes share `server/` code and are deployed from the *same*
  Docker image; the worker is a separate esbuild ESM bundle to dodge
  Nuxt's tree-shaking.
- Postgres holds the graph (`entities`, `relations`, `chunks`) with HNSW
  cosine indexes on embeddings and a GIN index on the auto-generated
  `text_tsv` column.
- Redis backs BullMQ queues.

## Pipeline shape

```
fetch  →  walk + lang-detect  →  AST parse (TS / Py / Go)
                                                │
chunk (entity-aligned)  ◀──────────────────────┘
        │
        ▼
embed chunks (text-embedding-3-small, batched)
        │
        ▼
LLM annotate {class, function, module}: description, concepts, patterns
        │
        ▼
embed entity descriptions
        │
        ▼
resolve duplicates (normalised name + ≥0.9 cosine)
        │
        ▼
git history + per-file hotness
        │
        ▼
ready
```

Each step writes progress to `workspaces.progress` (JSON) and broadcasts via
SSE to the browser.

## KAG operators

The query planner produces JSON plans like:

```json
{
  "reasoning": "Walk callers transitively, then summarise.",
  "steps": [
    { "id": "s1", "op": "find_symbol",
      "params": { "name": "processPayment", "type": "function" } },
    { "id": "s2", "op": "get_callers",
      "params": { "target": "$s1", "transitive": true, "maxDepth": 5 } },
    { "id": "s3", "op": "get_summary", "params": { "entity": "$s2" } },
    { "id": "s4", "op": "answer",
      "params": { "question": "Who calls processPayment?", "context": ["$s2", "$s3"] } }
  ]
}
```

| Operator | Returns | Notes |
|---|---|---|
| `find_symbol` | Entity[] | exact or fuzzy by normalised name |
| `find_file` | Entity[] | glob (`README*`, `src/*.ts`) |
| `get_callers` / `get_callees` | Entity[] | BFS over `calls` edges |
| `get_dependencies` / `get_dependents` | Entity[] | BFS over `imports` |
| `find_implementations` | Entity[] | extends/implements edges |
| `git_history` | Commit[] | newest-first, optional `since` |
| `find_by_concept` | Entity[] | cosine over `entities.embedding` (descriptions) |
| `vector_search_chunks` | Chunk[] | pure vector |
| `hybrid_search` | Chunk[] | vector + tsvector + RRF |
| `retrieve_code_chunks` | Chunk[] | via `entity_chunks` mutual index |
| `get_summary` | Entity summaries | id + name + description |
| `answer` | Streaming text | with `[chunk:UUID]` / `[entity:UUID]` citations |

## Tests

```bash
pnpm test       # vitest, files run sequentially against the dev DB
pnpm typecheck  # nuxt typecheck (vue-tsc 3 + strict TS)
pnpm lint
```

114+ tests cover: parsers per language, AST-aware chunking, git history,
embedding provider, hybrid search with RRF, LLM annotation, entity
resolution, every KAG operator, plan executor reference resolution and
cycle detection, planner happy path + fallback, full indexing pipeline
end-to-end on fixtures, schema integrity, env validation, AES-GCM
encryption, and logger trace inheritance.

## Production deploy

`docker-compose.prod.yml` brings up postgres + redis + app + worker +
Caddy. A `.env` with secret values and `APP_DOMAIN` is required.

```bash
# On the host
cp .env.example .env  # fill in real secrets and APP_DOMAIN

# Pull and start
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d

# Run migrations (one-shot)
docker compose -f docker-compose.prod.yml exec app node -e "import('./.worker/migrate.mjs')"
# or rebuild image with pnpm db:migrate baked into entrypoint.

# Nightly backup (host cron)
0 3 * * *  docker compose -f /srv/codegraph/docker-compose.prod.yml \
             exec -T postgres /usr/local/bin/backup.sh
```

Caddy handles SSL via Let's Encrypt — set `APP_DOMAIN` to a real domain
pointing at the host.

## Limitations (MVP)

- Public GitHub repos and ZIP uploads only. No private repos / GitLab /
  Bitbucket.
- TypeScript, JavaScript, Python, Go. No Rust, Java, C/C++ in the MVP.
- No real-time re-indexing — workspaces must be re-created to refresh.
- Single user per workspace.
- AST parsing is best-effort: dynamic imports, decorators, re-exports,
  and `__import__` are not fully resolved.
- LLM annotation creates duplicate concepts that the resolver may not
  catch every time (mid-band similarity is only flagged, not merged).
- Sigma.js graph view is fine up to ~5k nodes; beyond that, enable the
  type filter to narrow scope.
- Cost: ~$0.5–2 of OpenAI usage for a typical 500-file repo, depending
  on annotation depth. `LLM_BUDGET_USD_PER_INDEX` is wired through but
  not yet enforced as a hard stop.

## Repository layout

```
app/                 Nuxt app (pages, components, composables)
server/
  api/               Nitro endpoints
  db/                Drizzle schema, client, migration runner
  indexer/           Source fetch, parsers, chunking, git, persist, embed, annotate
  kag/               operators/, executor, planner
  providers/         openai-backed embeddings + LLM + mocks
  workers/           BullMQ worker entrypoint + esbuild build
  queues/            queue + connection setup
  lib/               env, logger, crypto
shared/
  schemas/           Zod: plan, annotation, workspace
  types/             cross-cutting TS types
docker/              Dockerfile, init-db.sql, Caddyfile, backup.sh
drizzle/             generated migrations + raw/0001_tsvector.sql
tests/
  fixtures/repos/    ts-sample, py-sample, go-sample
  unit/              parsers, env, logger, crypto, chunker, executor, planner
  integration/       db, pipeline, hybrid-search, operators, executor-plan, …
```

## License

MIT
