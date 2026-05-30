# Architecture

A bird's-eye view of how RepoBuddy goes from "user pastes a GitHub URL" to "user gets a cited answer in chat."

## Process topology

There are two long-running processes plus three stateful services:

```mermaid
flowchart TB
    subgraph Client
      Browser["Browser<br/>Vue 3 + Nuxt 4"]
    end

    subgraph Processes["Long-running processes"]
      Web["Nuxt Web<br/>(Nitro routes + SSR)"]
      Worker["Indexer Worker<br/>(BullMQ consumer)"]
    end

    subgraph State["State"]
      Postgres[("Postgres 16<br/>+ pgvector + pg_trgm")]
      Redis[("Redis<br/>queue + cache")]
    end

    subgraph External["External"]
      OpenAI[(OpenAI API)]
      GitHub[(GitHub REST)]
    end

    Browser -->|HTML/SSR| Web
    Browser -.->|SSE chat stream| Web
    Browser -.->|SSE indexing progress| Web

    Web --> Postgres
    Worker --> Postgres
    Web --> Redis
    Worker --> Redis

    Web -->|chat / answer / embed| OpenAI
    Worker -->|annotate / embed| OpenAI

    Web -->|issues, PRs| GitHub
    Worker -->|shallow clone, PR history| GitHub
```

**Why split web and worker:** indexing is CPU- and IO-heavy (AST parsing, LLM calls, embedding batches). Keeping it out of the Nitro request loop means chat latency is independent of how many repos are mid-index. The worker bundles separately (`server/workers/build.ts`) so Nuxt's tree-shaking doesn't drop the BullMQ entrypoint.

## End-to-end: "I just pasted a GitHub URL"

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant B as Browser
    participant W as Web (Nitro)
    participant Q as Redis (BullMQ)
    participant K as Worker
    participant P as Postgres
    participant O as OpenAI
    participant G as GitHub

    U->>B: paste github.com/owner/repo
    B->>W: POST /api/workspaces
    W->>P: INSERT workspaces (status='pending')
    W->>Q: enqueue 'index-workspace' job
    W-->>B: { workspace.id }
    B->>W: GET /api/workspaces/:id/progress (SSE)

    K->>Q: pick job
    K->>G: shallow clone (depth=200)
    K->>K: walk + parse (ts-morph, tree-sitter)
    K->>P: persist entities + relations
    K->>O: chunk embeddings (batched)
    K->>P: persist chunks + entity_chunks
    K->>O: LLM annotation (concepts, patterns)
    K->>P: persist concept entities + relations
    K->>G: fetch + persist merged PRs
    K->>P: UPDATE workspaces (status='ready', gitInsights)
    K->>Q: emit progress events

    W-)B: SSE 'ready' (via progress poller)
    B->>W: GET /w/:id  (chat page)
    B->>W: GET /api/workspaces/:id/onboarding
    W->>P: SELECT entrypoints, abstractions, ...
    W-->>B: Tour overlay JSON
```

## End-to-end: "I asked the chat a question"

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant W as Web (Nitro)
    participant P as Postgres
    participant O as OpenAI
    participant G as GitHub

    B->>W: POST /api/chat/:sessionId (question, mode, focus, history hint)

    Note over W: planned mode (default)
    W->>P: load prior chat_messages (last 16)
    W->>O: structured-output plan request (Zod-validated)
    O-->>W: { reasoning, steps[] }
    W-->>B: SSE 'plan'
    loop per step
      W->>P: dispatch operator (find_symbol, get_callers, retrieve_code_chunks, ...)
      P-->>W: rows
    end
    W-->>B: SSE 'trace'
    W->>O: stream answer with chunks + entities + (overview/issues/mermaid)
    O-->>W: text deltas
    W-->>B: SSE 'text' deltas
    W->>P: persist chat_messages (assistant turn + plan + trace)
    W->>P: cost ledger + quota accounting
    W-->>B: SSE 'citations' + 'done'

    Note over W: agentic mode (Auto-explore)
    rect rgb(245,240,255)
      W->>O: streamWithTools(messages, [12 KAG tools])
      loop until model emits no tool_calls (max 12 iters)
        O-->>W: tool_call(s)
        W->>P: execute operator
        P-->>W: rows (trimmed to 30 items × 4KB strings)
        W->>O: append role:'tool' messages, continue
      end
      W-->>B: SSE 'tool_step' (per dispatch) + 'text' final
    end
```

## Data model — the five load-bearing tables

```mermaid
erDiagram
    workspaces ||--o{ entities : owns
    workspaces ||--o{ chunks : owns
    workspaces ||--o{ relations : owns
    workspaces ||--o{ chat_sessions : owns
    entities ||--o{ relations : "from / to"
    entities }o--o{ chunks : "via entity_chunks (mutual)"
    chat_sessions ||--o{ chat_messages : has
```

- `entities` — graph nodes. `type` is one of `file | module | class | function | type | variable | component | route | test | concept | pattern | decision | commit | pull_request | person | document`. Carries a JSONB `metadata` for type-specific fields (commit sha + diff, PR refs, etc.) and a `vector(1536)` embedding once the LLM-annotation pass has summarised it.
- `relations` — graph edges. `type` is one of `imports | calls | extends | implements | uses_type | defined_in | contained_in | renders | handles | tested_by | implements_concept | follows_pattern | mentioned_in | modified_by | authored | introduced_in | relates_to`.
- `chunks` — code/doc/diff slices keyed by `(workspace_id, file_path, start_line, end_line)`. Carries text + `vector(1536)` + a generated `tsvector` column for hybrid search.
- `entity_chunks` — many-to-many between entities and chunks. Lets the answer operator hydrate citations both ways: from entity → its code, from chunk → its enclosing entity.
- `chat_sessions` / `chat_messages` — assistant memory + saved `plan` and `trace` JSONB per assistant turn, used by the Reasoning Inspector when replaying history.

Full schema: [`server/db/schema.ts`](../server/db/schema.ts).

## Key file pointers

| Concern | Location |
| --- | --- |
| Indexer orchestration | `server/indexer/pipeline.ts` |
| Source fetch (clone, ZIP, lang detect) | `server/indexer/source/` |
| Parsers (TS/JS, Python, Go) | `server/indexer/parsers/` |
| AST-aware chunker | `server/indexer/chunking/chunker.ts` |
| LLM annotation | `server/indexer/annotate.ts` |
| Entity resolution (dedup) | `server/indexer/resolve.ts` |
| PR history fetch | `server/indexer/pr-history.ts` |
| KAG operators (20 of them) | `server/kag/operators/index.ts` |
| Planner (LLM → Zod-validated JSON) | `server/kag/planner.ts` |
| Executor (topo sort + `$sN` resolver) | `server/kag/executor.ts` |
| Agentic loop (tool-use) | `server/kag/agentic.ts` |
| Chat endpoint | `server/api/chat/[sessionId].post.ts` |
| Project overview (Tour data) | `server/lib/project-overview.ts` |
| LLM provider abstraction | `server/providers/llm.ts` |
| Embeddings provider | `server/providers/embeddings.ts` |
| Cost / quota guardrails | `server/lib/cost-log.ts`, `server/lib/quotas.ts` |
| Chat composable | `app/composables/useChat.ts` |
| Message render + lazy mermaid/shiki | `app/components/ChatMessage.vue` |
| Reasoning Inspector | `app/components/ReasoningInspector.vue` |
| Tour overlay | `app/components/WorkspaceOnboarding.vue` |
| Treemap | `app/components/WorkspaceTreemap.vue` |
| Neighbour graph drawer | `app/components/EntityNeighbourGraph.vue` |

## Operational guardrails

- **Cost** — `LLM_BUDGET_USD_PER_INDEX` (default ~$3) hard-stops a run if the annotation step would exceed it. Per-user `users.user_quotas` (workspaces / messages / tokens per day) gate runtime usage.
- **Rate limits** — Octokit anonymous (60 req/h per IP) is the only external rate, used by `list_issues` / `list_prs` / `find_similar_issues` / PR-history indexer. All wrap try/catch and degrade gracefully.
- **Backoff** — `server/providers/embeddings.ts` uses a token-bucket rate limit + exponential backoff on 429s.
- **Observability** — Pino structured JSON logs with `AsyncLocalStorage`-backed `traceId`. Prometheus metrics (`repobuddy_chat_requests_total`, `repobuddy_llm_cost_cents_total`, `repobuddy_queue_depth`, etc.). Loki collects container stdout, Grafana panels in `infra/grafana/dashboards/*.json`.
- **Idempotency** — every indexer step is wrapped in `try { ... } catch { workspace.error + status='failed' }`. Re-index truncates per-workspace state and re-runs; `entities` and `pull_request` rows use `(workspace_id, qualified_name)` unique constraint with `ON CONFLICT DO NOTHING` so re-runs are safe.

## Where this differs from "plain RAG"

Most "chat with your code" tools follow:

```
question → embed → similarity-search chunks → LLM answer
```

That fails for any question that needs traversal ("who calls X?"), enumeration ("list all routes"), or anchoring on a specific issue/PR/commit. We build a **knowledge-augmented graph** (KAG): entities + relations are first-class, and the LLM picks operators to traverse the graph instead of just retrieving raw text.

Detailed walkthrough: [`docs/kag-planning.md`](kag-planning.md).
