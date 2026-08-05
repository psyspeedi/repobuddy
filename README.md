<div align="center">

# RepoBuddy

**Your first PR to any open-source repo. Faster.**

RepoBuddy indexes a public GitHub repository into a typed knowledge graph and lets you ask anything about it — what runs, what matters, where a safe first contribution could land — with answers grounded in the actual code.

<p>
  <a href="#live-demo">Demo</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#mcp-server">MCP server</a> ·
  <a href="#for-maintainers">For maintainers</a> ·
  <a href="#run-locally">Run locally</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="docs/kag-planning.md">KAG planning</a> ·
  <a href="docs/indexing-pipeline.md">Indexing pipeline</a> ·
  <a href="docs/frontend.md">Frontend</a>
</p>

<p><a href="README.ru.md">🇷🇺 Read in Russian / Читать по-русски</a></p>

</div>

---

## Live demo

There is none — RepoBuddy is self-hosted only right now, with no public instance. Follow [Run locally](#run-locally) to bring one up.

Repositories worth pointing a local instance at, once it is running:

| Repo | Why it's interesting |
| --- | --- |
| `developit/mitt` | Tiny (~30 lines of core) — good for seeing how granularly entities and chunks decompose. |
| `sindresorhus/p-limit` | One-function library with deep type magic. |
| `colinhacks/zod` | Mid-sized TypeScript codebase with rich type relations. |

## What it does

Paste a public GitHub URL → RepoBuddy clones the repo, extracts AST entities and relations across TypeScript, JavaScript, Python and Go, builds a typed knowledge graph in Postgres + pgvector, and exposes:

- **Contributor's tour** — entry points, the classes and functions everything depends on, hot files, safe first-PR zones derived from the graph (has tests × stability × small file), the project's `CONTRIBUTING.md` / PR template / `CODE_OF_CONDUCT.md`, an auto-generated architecture diagram, and a setup guide extracted from the manifests and README.
- **Chat with cited answers** — a multi-step planner picks operators over the graph (`find_symbol → get_callers → retrieve_code_chunks → answer`), the executor runs them deterministically, and the final answer streams with every claim linked to the chunk or entity it came from.
- **Auto-explore (agentic) mode** — the LLM gets the operator catalogue as function-calling tools and loops on its own until it can answer. More expensive per turn, more thorough for exploratory questions.
- **Issue triage before you start** — ask about a specific issue and the plan opens with `find_resolution`, which checks whether the work is already done: indexed commits matching `fix/close/resolve #N`, live PRs in any state (including drafts and stale ones), and cosine-similar closed issues. Status comes back as `merged` / `open_pr` / `draft_pr` / `stale_pr` / `duplicate_closed` / `related` / `none`.
- **Walkthrough as a Mermaid sequence diagram** — ask "how does X work" and get the actual call chain rendered inline.
- **Treemap explore** — every file sized by LOC and tinted by hotness or coverage. Click a tile → its neighbour graph.
- **Reasoning Inspector** — every assistant turn carries its plan and trace; the inspector renders the plan as an SVG flowchart, or, in agentic mode, a timeline of tool dispatches grouped by iteration.
- **MCP server** — the same graph, addressable from Claude Code or Cursor. See [MCP server](#mcp-server).

## Architecture at a glance

```mermaid
flowchart LR
    Browser["Browser<br/>(Vue 3)"] -->|HTTPS| Caddy["Caddy<br/>(one domain, auto-TLS)"]

    Caddy -->|"/api/*, /auth/github*,<br/>/badge/*, SEO routes"| API
    Caddy -->|everything else| Web

    subgraph Server
      Web["Nuxt 4 SSR<br/>web:3000"]
      API["NestJS 10 API<br/>api:3001"]
      Worker["Indexer worker<br/>(BullMQ consumer)"]
    end

    Web -->|REST + SSE| API
    API -->|enqueue index job| Redis[("Redis 7<br/>(BullMQ, quotas,<br/>rate limits, sessions)")]
    Worker --> Redis

    API --> Postgres[("Postgres 16<br/>+ pgvector<br/>+ tsvector/GIN")]
    Worker --> Postgres

    API -->|plan / answer / embed| LLM[("OpenAI-compatible<br/>chat + embeddings")]
    Worker -->|annotate / embed| LLM
    API -->|issues / PRs| GitHub[("GitHub REST<br/>(Octokit)")]
    Worker -->|clone --depth 200| GitHub
```

Full breakdown: [`docs/architecture.md`](docs/architecture.md).

## How it differs from "chat with your code"

Basic chat over a repository is a commodity in 2026 — every editor ships it, and for "what does this function do" a plain embed-and-retrieve loop is genuinely enough. RepoBuddy is not trying to win that comparison.

What the graph buys you is the class of questions retrieval alone cannot answer:

- **Graph traversal, not similarity.** `get_callers` with `transitive: true` is a recursive CTE over the `relations` table. "Who calls X, three hops out" is a query, not a guess.
- **Citations that resolve.** Every answer carries `[chunk:UUID]` / `[entity:UUID]` markers that the UI turns into clickable badges opening the exact source — so a wrong answer is falsifiable in one click.
- **Issue ↔ PR ↔ commit linkage.** `find_resolution` answers "is this already fixed?" before you write code, in the default planned mode, not just in agentic mode.
- **Contributor's tour.** Entry points, core abstractions, safe first-PR zones and the setup guide are derived from the graph plus git history, not from asking an LLM to guess.

The planner picks from a catalogue of exactly **15 operators** ([`packages/shared/src/schemas/plan.ts`](packages/shared/src/schemas/plan.ts)) — graph traversal, hybrid retrieval (pgvector cosine + Postgres `ts_rank` fused via RRF), GitHub queries, and a `read_file` verb for verbatim content. A unit drift-guard ([`apps/api/test/unit/planner-catalogue.test.ts`](apps/api/test/unit/planner-catalogue.test.ts)) fails the build if the catalogue, the planner prompt and the agentic tool definitions drift apart.

Every plan and its trace are persisted with the assistant message, so reopening a chat shows not just the answer but the reasoning that produced it.

Detailed walkthrough: [`docs/kag-planning.md`](docs/kag-planning.md).

## MCP server

RepoBuddy exposes its graph over the [Model Context Protocol](https://modelcontextprotocol.io), so an agent in Claude Code or Cursor can traverse an indexed repository directly instead of grepping a working copy it may not even have checked out.

**Endpoint**: `POST /api/mcp` — Streamable HTTP, stateless. `GET` and `DELETE` return `405` (no SSE notification stream, no sessions to terminate), and JSON-RPC batches are rejected with `400`.

**Nine tools** ([`apps/api/src/modules/mcp/internals/tools.service.ts`](apps/api/src/modules/mcp/internals/tools.service.ts)):

| Tool | What it does |
| --- | --- |
| `list_workspaces` | Lists public indexed repositories. The only tool without `workspaceId` — the entry point every other call needs. |
| `search_code` | Hybrid search over all chunks. Billable (embeds the query). |
| `find_symbol` | Finds graph entities by name and kind; returns the `entityId` the traversal tools take. |
| `get_callers` | Incoming `calls` edges, `depth` 1–5 for transitive traversal. |
| `walkthrough` | Call chain around an entity plus a rendered Mermaid sequence diagram. |
| `read_file` | Verbatim file content, optionally narrowed to a line range. |
| `get_project_overview` | Entry points, core abstractions, good-first issues, hot files, contribution guide. |
| `list_issues` | Open issues already linked to indexed code. |
| `find_resolution` | Whether an issue is already fixed: commits, PRs, duplicates. Billable (embeds the issue corpus on a cache miss). |

Two deliberate exclusions:

- **`answer` is not exposed.** The MCP client already has a model — it does not need RepoBuddy's. The tools return structured graph data and let the caller's model do the reasoning.
- **Public workspaces only.** `loadPublicWorkspace` is the single path to a workspace in the MCP module, so a private one is unreachable by construction rather than by a permission check that could be forgotten.

The endpoint is unauthenticated, which is why it is bounded elsewhere: 120 requests/hour plus a 10-per-10-seconds burst limit per IP, the global daily spend cap on the two billable tools, and `MCP_ENABLED` as a kill switch.

Client configuration (Claude Code, Cursor and anything else that speaks Streamable HTTP):

```json
{
  "mcpServers": {
    "repobuddy": {
      "type": "http",
      "url": "http://localhost:3001/api/mcp"
    }
  }
}
```

Point `url` at your deployed origin (`https://<your-domain>/api/mcp`) when running behind Caddy.

## For maintainers

If you maintain a repository and want contributors to arrive oriented instead of asking the same three questions in every issue:

1. **Index your repository** — paste its GitHub URL on the home page and wait for the index to finish.
2. **Make the workspace public** — the visibility toggle on the workspace page. Public means anonymous visitors can explore and chat without an account, and the workspace becomes reachable over MCP.
3. **Put the badge in your README** — the workspace page renders the snippet with a copy button:

```markdown
[![Explore with RepoBuddy](https://<your-domain>/badge/<workspace-id>.svg)](https://<your-domain>/w/<workspace-id>)
```

The badge endpoint (`GET /badge/:file`, served outside the `/api` prefix so the URL stays short) is anonymous — GitHub proxies README images through camo, which carries no cookies, so `is_public` is the only access boundary. A private, missing or malformed id all return the same neutral "not found" badge with HTTP 200: distinguishing the cases would make the endpoint an id oracle, and a non-200 renders as a broken-image glyph that reads as "RepoBuddy is down".

The badge intentionally does **not** show index freshness. It would otherwise change on every upstream commit, and a README image that flickers between states is worse than one that simply points at an explorable snapshot. Freshness lives in the app instead: the workspace page shows how many commits the index is behind `HEAD`, from `GET /api/workspaces/:id/freshness`.

## Tech stack

**Frontend** — Nuxt 4, Vue 3 Composition API, Tailwind 4, shadcn-nuxt + reka-ui, `marked` + `isomorphic-dompurify` for chat-message rendering, `shiki` for syntax highlighting (lazy-loaded, dual-theme via CSS variables), `mermaid` for diagrams (lazy-loaded), `d3-hierarchy` for the treemap, `sigma` + `graphology` for the neighbour graph, `@nuxtjs/i18n` (en/ru, cookie-driven, no URL prefix), `@nuxtjs/color-mode`.

**Backend** — NestJS 10 on Express, split into an HTTP API (`apps/api/src/main.ts`) and a standalone worker context (`apps/api/src/main.worker.ts`, no HTTP server). BullMQ via `@nestjs/bullmq`, `drizzle-orm` over `postgres` (pgvector through a `customType`), GitHub OAuth via `@nestjs/passport` + `passport-github2` + `express-session` backed by `connect-redis`, AES-GCM encryption for stored GitHub and BYOK keys, Pino structured logging (`nestjs-pino`) with `traceId` via `AsyncLocalStorage`, `prom-client` metrics, `@nestjs/terminus` health checks, `@octokit/rest`, `@sentry/nestjs`.

**MCP** — `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport` in stateless mode.

**AI** — OpenAI SDK against any OpenAI-compatible provider (`LLM_BASE_URL` → Groq / OpenRouter / Together / Ollama / vLLM). Two tiers: `planning` for chat planning and answers (default `gpt-4o`) and `extraction` for bulk annotation during indexing (default `gpt-4o-mini`). Embeddings are `text-embedding-3-small` (1536-dim). BYOK supported per user — an encrypted key, base URL and model that override the server tiers.

**Code parsing** — `ts-morph` (TypeScript, JavaScript, Vue SFC), `web-tree-sitter` with WASM grammars (Python, Go).

**Monorepo** — pnpm workspaces: `apps/api`, `apps/web`, `packages/shared` (zod schemas and shared types, imported as `@repobuddy/shared`). Node ≥22, pnpm 9.15.0.

**DevOps** — Docker Compose dev stack (Postgres 16 + pgvector, Redis 7, and optionally Grafana + Loki + Prometheus + Promtail), production compose with Caddy auto-TLS, `pg_dump` backup script.

## Run locally

```bash
# 1. Clone + install
git clone <this-repo> repobuddy && cd repobuddy
pnpm install

# 2. Configure — .env lives in the monorepo root
cp .env.example .env
#   Required: DATABASE_URL, REDIS_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
#   NUXT_SESSION_PASSWORD (≥32 chars: openssl rand -base64 32),
#   ENCRYPTION_KEY (64 hex chars: openssl rand -hex 32),
#   and at least one of OPENAI_API_KEY / LLM_API_KEY.

# 3. Postgres + Redis, then migrations
pnpm db:up
pnpm db:migrate

# 4. Three processes, three terminals
pnpm dev:web       # Nuxt on :3000
pnpm dev:api       # NestJS on :3001
pnpm dev:worker    # standalone NestJS worker (BullMQ)

# 5. Open http://localhost:3000
```

Note that the root `pnpm dev` starts only web and api — indexing will not run without `pnpm dev:worker`.

**GitHub OAuth App**: set the Authorization callback URL to `{API_URL}/auth/github/callback` (in dev, `http://localhost:3001/auth/github/callback`). It points at the API, not the frontend — `/auth/github` and `/auth/github/callback` are deliberately kept outside the `/api` prefix so this URL stays stable.

Optional dashboards: `docker compose up -d grafana prometheus loki promtail` → Grafana at `http://localhost:3301` (`admin` / `admin`).

## Tests

```bash
pnpm -r typecheck                                     # all workspaces (web needs `nuxt prepare` first)
pnpm test                                             # everything
pnpm --filter @repobuddy/api test test/unit           # unit tests
pnpm --filter @repobuddy/api test test/integration    # integration (needs Postgres + Redis)
pnpm --filter @repobuddy/api test:watch
```

Tests live in `apps/api` only (vitest): 19 unit files and 8 integration files. Integration tests share one Postgres and one Redis, so the suite runs sequentially (`fileParallelism: false`, `singleFork: true`) to avoid TRUNCATE races. Unit tests cover the indexer parsers (TS/JS, Python, Go), the chunker, the KAG executor and planner schema, the crypto helpers, the badge renderer, the SSE parser, and two drift-guards — one over the operator catalogue, one over the MCP tool catalogue. Integration tests run the full indexing pipeline against fixture repositories, plus the operators, hybrid search, annotation, dedup and git-history parsing, with providers mocked via `CODEGRAPH_MOCK_PROVIDERS=1`.

The test database comes from `TEST_DATABASE_URL`, falling back to `postgres://repobuddy:repobuddy@localhost:5532/repobuddy_test`. The helper refuses to run unless the database name ends in `_test` — that guard is what stops `pnpm test` in a shell with a live `DATABASE_URL` exported from `TRUNCATE CASCADE`-ing real data. Migrate it with `pnpm db:migrate:test`.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs two jobs on push and PR to `main`: typecheck plus unit tests, then integration tests against a pgvector and a Redis service.

## Deployment notes

Production is `docker compose -f docker-compose.prod.yml up -d --build`: postgres, redis, api, worker, web and caddy. The api and web containers do not publish ports — Caddy is the only entry point.

- **Routing.** [`docker/Caddyfile`](docker/Caddyfile) serves one domain and splits traffic: `/api/*`, `/auth/github*`, `/badge/*` and the SEO routes (`robots.txt`, `sitemap.xml`, `feed.xml`, `indexnow/*`) go to `api:3001`, everything else to `web:3000`. `flush_interval -1` on the API proxy is load-bearing — without it the chat and index-progress SSE streams get buffered and arrive all at once.
- **`GITHUB_TOKEN` is worth setting.** Without it every GitHub call is anonymous: 60 requests/hour per IP, shared across `list_issues`, `find_resolution` and PR-history indexing. A read-only public-scope PAT raises that to 5000/hour.
- **`/api/metrics` is closed by default.** It requires `Authorization: Bearer $METRICS_TOKEN`. If `METRICS_TOKEN` is unset the endpoint returns 404 in production (and stays open in dev/test).
- **`MCP_ENABLED` is the MCP kill switch.** Defaults to on; any value other than `true`/`1`/`yes`/`on` disables the endpoint, which then reads as 404.
- **`ADMIN_LOGINS` starts empty.** Until you set it, nobody has admin access — and admins are the only accounts that bypass quotas and the daily spend cap. The admin area itself is a single operator console (overview, users, workspaces, audit log), gated entirely behind that list; it is not part of the contributor-facing product and a visitor never sees it.
- **`TRUST_PROXY_HOPS` must match your topology.** Defaults to `0` (no proxy trusted); the bundled compose file sets `1`, where Caddy is the only entry point. Every per-IP rate limit keys off the resulting `req.ip`, so trusting a hop that does not exist lets a client mint a fresh bucket per request by varying `X-Forwarded-For`.
- **The compose file passes the operational levers through explicitly.** `docker compose` does not inject `.env` into containers; it only interpolates `${VAR}` into the keys listed in `docker-compose.prod.yml`. Anything you add to `.env` that is not listed there is ignored by the running process.
- **`drizzle/meta/` is committed on purpose.** The drizzle migrator reads `_journal.json` to decide what is pending; ignoring that directory would break migrations on a fresh clone.
- **Migrations are manual.** Nothing runs them on container start: `pnpm --filter @repobuddy/api db:migrate` with the production `DATABASE_URL`, from the api container or the host.
- **The API and worker run under `tsx` in production, not compiled output.** `nest build` with swc is wired up (`.swcrc`, `nest-cli.json`, the `build` script), but the swc emit rewrites the `#shared/*` and `#server/*` subpath aliases into paths relative to `src/`, which break once the code moves to `dist/`. Switching to `node dist/src/main.js` needs either `tsc-alias` post-processing or migrating ~84 import sites to relative paths. This is a real compromise on cold start and memory, not a preference — it is simply not paid down yet.

There is no CD. CI type-checks and runs tests; deploying is manual.

## Status & limitations

**Language coverage.** AST extraction covers TypeScript, JavaScript (including Vue SFCs, parsed as TypeScript), Python and Go. Everything else — Java, Rust, C#, C/C++, Ruby, PHP — lands in fallback whole-file chunks: findable by search, but contributing no entities or edges to the graph. Within supported languages, coverage is deliberately best-effort: re-exports, generic resolution and dynamic imports are approximate, and `tested_by` is inferred from import paths in test files rather than symbol names.

**Index size caps.** `MAX_FILES_PER_INDEX` (default 2000) stops the walk and marks the index truncated — the workspace still becomes usable and the UI shows a partial-coverage notice. `MAX_REPO_SIZE_MB` (default 200) is checked with `du -sk` *after* cloning, so an oversized repo costs the clone before it is rejected. Clones are `--depth 200 --single-branch`: older history, other branches and tags never enter the graph, and hotness is computed over that truncated window.

**Indexing economics.** Bulk annotation runs on the cheap `extraction` tier (default `gpt-4o-mini`), not the planning model — that split is the main cost lever. `LLM_BUDGET_USD_PER_INDEX` (default `2.0`) is genuinely enforced inside the annotation phase: workers check accumulated spend before each entity and stop when it is exhausted, leaving the remaining entities without descriptions rather than failing the index (`stats.annotationBudgetHit` surfaces this in the UI).

The ledger is still an estimate — the annotation step gets no `usage` data back, so it approximates input tokens from character counts — but it is now an honest one. Cost is accumulated in micro-cents (`usd_micro_cents`, 1 cent = 10 000), because a single annotation on the extraction tier costs about 0.04 cents and any integer-cent unit would either round it to nothing or, if rounded up per call, overstate a run by roughly 50x. Earlier revisions did exactly that, which quietly exhausted the default $2 budget after about a hundred entities.

The same estimate feeds `COST_BUDGET_USD_PER_DAY` (default `3`), which gates indexing, chat and the billable MCP tools with a 503. One medium repository can therefore consume most of the default daily allowance — raise it, or use BYOK, if that is not the behaviour you want. BYOK users bypass both caps and pay their own provider directly.

**Index staleness.** The index is a snapshot taken when it ran; nothing refreshes it automatically. `GET /api/workspaces/:id/freshness` reports how many commits behind `HEAD` it is, and the workspace page surfaces that; reindexing is a manual button for the owner. The README badge does not reflect freshness, by design (see [For maintainers](#for-maintainers)).

**Other.** Only public GitHub repositories can be indexed — the ZIP upload path exists in the source but the pipeline rejects it. The agentic chat mode is opt-in because each turn can cost several times a planned answer. Mobile works end to end: side panels (Reasoning Inspector, Source Viewer, Neighbour Graph) become a bottom sheet below `lg`, though it remains a secondary scenario. `apps/api` has no lint configuration (the scripts are stubs, ESLint is wired up only for `apps/web`) and `apps/web` has no tests. `apps/api/src/modules/workers/internals/build.ts` is a dead esbuild script left over from the Nitro era — nothing imports it, and it is waiting to be deleted.

## License

MIT — see [`LICENSE`](LICENSE).
