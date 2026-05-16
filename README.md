# CodeGraph

AI assistant for understanding codebases via knowledge graphs.

CodeGraph indexes a Git repository into a hybrid knowledge graph that combines
deterministic AST structure (files, classes, functions, imports, calls) with
LLM-generated semantic descriptions (concepts, patterns, summaries) and Git
history (commits, authors, hotness). It then answers natural-language questions
through **logical-form planning over the graph** (KAG approach), returning
answers with inline citations and a visualised reasoning trace.

## Status

**Work in progress.** Phase 0 (Bootstrap) complete.

### What works

- Nuxt 4 application skeleton with strict TypeScript.
- TailwindCSS v4 + shadcn-vue (Button component scaffolded).
- Light/dark theme via `@nuxtjs/color-mode`.
- Vitest with sample smoke tests.

### What's next

- Phase 1: Docker Compose (Postgres + pgvector + Redis), Drizzle schema, GitHub OAuth, BullMQ worker skeleton.
- Phase 2: Source fetching + AST parsers (TypeScript, Python, Go), AST-aware chunking, Git history, basic graph viewer.
- Phase 3: Embeddings + hybrid search + RAG chat.
- Phase 4: LLM semantic layer with structured outputs.
- Phase 5: KAG planning + reasoning execution.
- Phase 6: Reasoning inspector + UI polish.
- Phase 7: Production deploy (Caddy + Docker Compose).

## How to run

Requirements: Node.js ≥22, pnpm ≥9.

```bash
pnpm install
pnpm dev      # http://localhost:3000
pnpm test     # run vitest
pnpm typecheck
pnpm lint
```

## Architecture (planned)

```
Browser → Caddy → Nuxt 4 (SSR + Nitro API)
                    ├── PostgreSQL 16 + pgvector
                    ├── Redis (BullMQ queues)
                    ├── BullMQ worker process
                    ├── OpenAI API
                    └── GitHub API
```

The indexing pipeline (AST → chunks → embeddings → LLM annotation) runs in a
background worker process so HTTP handlers stay fast. Question answering
combines a structured query planner (`gpt-4o`) with graph operators to produce
multi-hop reasoning traces.

## Tech stack

- **Framework:** Nuxt 4 + Nitro
- **Language:** TypeScript (strict)
- **Database:** PostgreSQL 16 + pgvector + pg_trgm
- **Queues:** Redis + BullMQ
- **ORM:** Drizzle
- **AST:** ts-morph (TS/JS), web-tree-sitter (Python, Go)
- **LLM:** OpenAI (gpt-4o for planning, gpt-4o-mini for extraction)
- **Embeddings:** text-embedding-3-small (1536-dim)
- **UI:** shadcn-vue + TailwindCSS v4
- **Graph viz:** Sigma.js + Graphology
- **Auth:** nuxt-auth-utils (GitHub OAuth)
- **Tests:** Vitest

## Limitations (planned MVP)

- Public GitHub repos and ZIP uploads only.
- Languages: TypeScript, JavaScript, Python, Go.
- Single-user-per-workspace; no real-time re-indexing.
- Read-only (no code generation).

## License

MIT
