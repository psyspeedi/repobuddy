# Beyond "chat with your code": building a knowledge-graph + planner layer on top of RAG

> A walkthrough of the design choices behind RepoBuddy — what a typed-graph KAG architecture gets you that plain RAG can't, and the frontend details that make it feel live.

---

## The "chat with your code" problem

Every AI-over-code product follows roughly the same recipe:

```
question → embed(question) → similar-chunks(vector_db) → LLM(chunks + question) → answer
```

That works for surface-level questions: "what does the README say about installation?", "find a function that mentions JWT". It falls apart the moment a question requires:

- **Traversal**: "who calls processPayment, transitively, two hops deep?" — there is no embedding-similarity signal between a caller and a callee.
- **Enumeration**: "list every HTTP route" — that's a set query, not similarity ranking.
- **Anchored reasoning**: "I want to work on issue #191 — where do I start?" — the issue body isn't a chunk; the file paths it mentions need to be matched to entities; the touched functions' callers need to be inspected.
- **Cross-source linking**: "how was this kind of issue fixed before?" — needs PR history, not chunk similarity.

Plain RAG can't do any of these. The fix isn't a better embedding model — it's a different data shape.

## KAG: knowledge graph + operator planner

A **knowledge-augmented graph** (KAG) flips the pipeline:

```
question → planner(LLM, operator-catalogue) → typed-plan → executor → operator results → LLM(grounded) → answer
```

The repo is indexed once into a typed graph: nodes are entities (`class`, `function`, `file`, `commit`, `pull_request`, `concept`, `pattern`, ...), edges are relations (`calls`, `imports`, `tested_by`, `mentioned_in`, `fixes`, ...), and chunks live on the side via a mutual `entity_chunks` index. The graph has 16 entity types and 17 relation types in this project.

The chat side exposes **20 operators**:

| Family | Operators |
| --- | --- |
| Lookup | `find_symbol`, `find_file`, `read_file`, `get_project_overview`, `list_concepts` |
| Graph traversal | `get_callers`, `get_callees`, `get_dependencies`, `get_dependents`, `find_implementations`, `walkthrough` |
| Search | `hybrid_search`, `vector_search_chunks`, `search_docs`, `find_by_concept` |
| Retrieve | `retrieve_code_chunks`, `get_summary` |
| Analysis | `tests_for` |
| External | `list_issues`, `list_prs`, `find_similar_issues`, `find_prs_for_issue`, `git_history` |
| Sink | `answer` |

An LLM **planner** receives the question + the operator catalogue + a handful of few-shot plans and emits a structured JSON plan validated against a Zod enum. An **executor** topo-sorts the plan by `$sN` step references, dispatches operators in order, caches intermediate results, and feeds everything into the final `answer` operator. The whole plan + trace gets persisted on the assistant message so a Reasoning Inspector can replay it.

### What a plan actually looks like

For "I want to work on issue #191 — where do I start?", a real plan is five steps:

```json
{
  "reasoning": "Specific issue resolution — fetch it, then expand the top relatedEntities (walkthrough + callers) so the answer can ground in real code, not just point back to GitHub.",
  "steps": [
    { "id": "s1", "op": "list_issues", "params": { "issueNumber": 191 } },
    { "id": "s2", "op": "walkthrough", "params": { "entity": "$s1.issues[0].relatedEntities", "limit": 8 } },
    { "id": "s3", "op": "get_callers", "params": { "target": "$s1.issues[0].relatedEntities", "transitive": false, "limit": 12 } },
    { "id": "s4", "op": "retrieve_code_chunks", "params": { "entities": "$s3" } },
    {
      "id": "s5",
      "op": "answer",
      "params": {
        "question": "I want to work on issue #191 — where do I start in the code?",
        "context": ["$s1", "$s2", "$s3", "$s4"],
        "style": "detailed"
      }
    }
  ]
}
```

Three things to notice:

1. **`$s1.issues[0].relatedEntities`** — the executor has a small reference resolver that walks `.field` and `[idx]` selectors on prior results. The planner can chain typed pipelines without the LLM having to invent its own variable scheme.
2. **`list_issues` is not a chunk search.** It hits the GitHub REST API on the workspace's source repo, regex-extracts file-path and backtick references from the issue body, and resolves them against the indexed entities. The output already contains a `relatedEntities` array that the next step consumes directly.
3. **The planner is not freeform.** Every operator name + param shape is validated by a Zod schema after the LLM returns its JSON. Validation failures retry once with an error-feedback prompt; a second failure falls back to a deterministic `hybrid_search + answer` plan so the user is never stuck.

### Why a graph beats vector similarity here

`get_callers` is a recursive CTE over the `relations` table with `type='calls'`. A vector search will **never** find a function that doesn't lexically resemble its callees. `find_implementations` matches by `type='implements'` and `type='extends'`. `tests_for` matches by `type='tested_by'`, which the indexer derives from the test files' `imports` edges.

These are SQL queries on indexed columns. They cost milliseconds and they return correct answers. The embedding step is great for the questions where it's the right tool ("where is discount logic implemented?" — that's `find_by_concept` over LLM-annotated entity descriptions), but it's strictly worse than the right SQL when traversal is the actual question.

## Agentic mode as the second pipeline

Planned mode commits to a plan up front. That's correct most of the time and predictable when it's wrong. But sometimes you want the model to react to intermediate results — "if relatedEntities is empty, try a different approach". For those, RepoBuddy ships an **agentic mode** that exposes the operator catalogue as OpenAI function-calling tools:

```ts
// Pseudocode of the loop in server/kag/agentic.ts
const messages = [systemPrompt, ...history, { role: 'user', content: question }]
while (iter < 12) {
  const result = await llm.streamWithTools(messages, TOOL_DEFS)
  if (!result.toolCalls?.length) break  // model produced final text
  for (const call of result.toolCalls) {
    const out = await OPERATORS[call.name](call.parsedArgs, ctx)
    messages.push({ role: 'tool', tool_call_id: call.id, content: trim(JSON.stringify(out)) })
  }
}
```

Trim is important — each tool result is capped (30 array items × 4 KB strings) before it re-enters the prompt, so a `list_issues` that returns 60 issues doesn't blow up the next turn's input tokens.

The agentic loop is gated behind a checkbox in the chat input ("Auto-explore") because it costs 4–8× more per question than a planned answer. Planned mode is the default for a reason.

## What this gets you on the user side

Three things the user sees that fall out of the design above:

### Transparent reasoning

Every assistant turn carries its `plan` and `trace` JSONB next to the message text. The Reasoning Inspector renders them — in planned mode as an SVG flowchart (steps as nodes, `$sN` refs as edges, coloured by outcome); in agentic mode as a timeline grouped by iteration. Reopening a shared chat URL shows not just the answer but the reasoning. Most "chat with code" tools treat reasoning as a hidden implementation detail; surfacing it is a competitive moat for AI-skeptical users who want to verify before they trust.

### Citation discipline

The `answer` system prompt is strict about three citation forms:

- Code claims → `[chunk:UUID]` (resolves to the source-viewer drawer)
- Entity claims → `[entity:UUID]` (resolves to the neighbour-graph drawer)
- GitHub issues → `[#42](issue-url)` — explicitly **never** `[entity:42]` or `[chunk:42]` (the model genuinely tried to do this early on, because it had been trained that numbers in citation brackets are an OK pattern)

After the stream finishes, the endpoint runs an `extractCitations` pass over the assembled text, validates every `[chunk:UUID]` against actual `chunks` table rows, and ships an `invalid: string[]` list to the client. The frontend renders invalid citations with a destructive-coloured warning badge. The model is held to its own citations.

### Walkthrough as a Mermaid sequence diagram

The `walkthrough` operator gathers (target → callees → tests → enclosing parent) and emits a `mermaid` sequence-diagram source string alongside the entity array. The answer operator injects the diagram into the user prompt verbatim with an instruction to include it in the response inside a triple-backtick fence. The chat-message component then lazy-imports `mermaid` (~250 KB, only on first use), renders the diagram to SVG, sanitises with DOMPurify's SVG profile, and replaces the `<pre>` with the rendered diagram. A 12-step call chain reads in five seconds instead of two minutes of pasting code into another window.

## Frontend pieces worth a look

A few choices that aren't obvious from the architecture diagram:

### Lazy heavy renderers

`mermaid` is ~250 KB and `shiki` carries its own grammar set. Both are loaded with dynamic `import()` on first use inside a DOM post-processor that runs after the markdown pass. The mermaid renderer is cached per session (one module-level promise); shiki's `codeToHtml` does its own lazy-grammar-load internally. Cold chats with no code blocks pay nothing. The pattern lives in [`app/components/ChatMessage.vue`](../app/components/ChatMessage.vue) as `renderMermaidBlocks` and `highlightCodeBlocks`.

### Dual-theme syntax highlighting via CSS variables

Shiki's single-theme API bakes background + token colours as inline `style="color: #X; background-color: #Y"`. After the user toggles the theme, those inline styles are stuck — the white pre-block sits on the dark surface until you re-render. The fix is shiki's dual-theme + `defaultColor: false` mode:

```ts
const rendered = await codeToHtml(source, {
  lang,
  themes: { light: 'github-light', dark: 'github-dark' },
  defaultColor: false,
})
```

That emits CSS variables on every span:

```html
<span style="--shiki-light: #008; --shiki-dark: #88f;">…</span>
```

A single global rule in `tailwind.css` maps them by the `.dark` class on `<html>`:

```css
.shiki, .shiki span { color: var(--shiki-light); background-color: var(--shiki-light-bg); }
.dark .shiki, .dark .shiki span { color: var(--shiki-dark); background-color: var(--shiki-dark-bg); }
```

Theme switch is pure CSS — no re-render, no flash, no lag. The amount of complexity this removes from the front-end is disproportionate to the size of the change.

### Robust SSE parsing

Naively joining SSE `data:` lines with `''` collapses `### Heading` plus the next `- item` into a single string with no separator: `"### Heading- item"`. The fix is to follow the spec: join with `\n`, strip exactly one leading `U+0020` per line. The parser is extracted into `shared/lib/sse.ts` and unit-tested independently.

### Mobile bottom-sheet

The three chat side-panels (Reasoning Inspector / Source Viewer / Neighbour Graph) sit in a `lg:flex` container that's `display: none` below the `lg` breakpoint. That meant on mobile, tapping a citation fired the `open-chunk` event into the void — the badge looked interactive but nothing happened.

The fix is a `BottomSheet` component that teleports to `<body>` (escaping any parent backdrop-filter that would otherwise pull `position: fixed` into a new containing block) and a `SidePanelStack` extraction so the same tab markup renders in both the desktop side column and the mobile sheet. `useIsMobile` is a one-liner `matchMedia` composable. Body scroll locks on open and unlocks on close + unmount.

## Observations from building this

Five things I'd tell someone designing a similar product:

1. **Pick the data shape before the model.** A typed graph + operator catalogue gives you queries you can verify; an embedding cloud gives you ranked guesses. They're not interchangeable.

2. **Persist the plan and the trace.** They cost almost nothing to store and they're the difference between "the assistant said X" and "the assistant said X because find_symbol → get_callers → retrieve_code_chunks returned these specific rows". The Reasoning Inspector is the most-praised piece of the UI, and it's free once you persist what's already in memory.

3. **Validate citations server-side.** The model will hallucinate UUIDs if you let it. Extracting all citations from the assembled stream and verifying against the database is ~30 lines and saves you from a class of bug that's invisible from the frontend.

4. **Drift between Zod enum / TS union / planner prose / tool defs is real and hits silently.** Every time you add an operator, you have to touch four places. TypeScript catches three of them; the planner prose (a string in a Vue file) drifts and the LLM stops emitting plans that use the operator. A 20-line drift-guard test prevents the entire class.

5. **Lazy-load anything heavier than 50 KB.** Mermaid, Shiki, Sigma, d3 — these add up. Dynamic `import()` inside the DOM post-processor that uses them means a chat with no code blocks downloads nothing.

## Stack

- **Frontend**: Nuxt 4, Vue 3 Composition API, Tailwind 4, shadcn-vue, lazy-loaded `shiki` + `mermaid`, `d3-hierarchy` + `sigma`, `@nuxtjs/i18n` (cookie-driven, en + ru), `@nuxtjs/color-mode`.
- **Backend**: Nitro, BullMQ workers, `drizzle-orm` (Postgres + pgvector via `customType`), `nuxt-auth-utils` for GitHub OAuth, Pino + Prometheus + Loki + Grafana, Octokit.
- **AI**: OpenAI gpt-4o + text-embedding-3-small. BYOK per user (encrypted at rest). Hybrid retrieval = vector cosine + Postgres `ts_rank` combined via RRF.
- **Code parsing**: `ts-morph` (TS/JS/Vue) + `web-tree-sitter` (Python, Go) with WASM grammars.

Repo: <!-- TODO: link --> (MIT). Docs: [architecture](architecture.md), [KAG planning](kag-planning.md), [indexing pipeline](indexing-pipeline.md), [frontend tour](frontend.md).
