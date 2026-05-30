# Frontend architecture

A guided tour of the non-trivial frontend pieces — what they do, where they live, why they're shaped the way they are.

## Stack

Nuxt 4 + Vue 3 Composition API + `<script setup>`. Tailwind 4 for utilities, shadcn-vue for primitives, `lucide-vue-next` for icons. State lives in composables — no Pinia, no Vuex. Internationalisation is `@nuxtjs/i18n` with the `no_prefix` strategy (same URL, cookie-driven locale).

## App shell

[`app/layouts/default.vue`](../app/layouts/default.vue) is a viewport-locked column:

```html
<div class="flex h-screen flex-col bg-background overflow-hidden">
  <header>…</header>
  <main class="flex flex-1 flex-col min-h-0 overflow-y-auto
               [&:has(.cg-no-scroll)]:overflow-hidden">
    <div class="container mx-auto …">
      <slot />
    </div>
  </main>
</div>
```

Two non-obvious bits:

1. **`overflow-y-auto` on `main`, not on the inner container.** The vertical scrollbar sits at the right edge of the window, not inside the centred `container mx-auto`. The container that limits width is a child of the scroll host, not the scroll host itself.

2. **`[&:has(.cg-no-scroll)]:overflow-hidden` opt-out.** Pages whose root carries `class="cg-no-scroll"` (chat, explore) want a viewport-locked layout with their own internal scrollers. The `:has()` selector lets them opt out of the page-level scroll without prop-drilling a `pageScrolls` flag through the layout.

## Chat composable

[`app/composables/useChat.ts`](../app/composables/useChat.ts) is the single source of truth for chat state — messages, streaming flag, session id, abort handle, focus pinning, history persistence, share-link session hydration.

The interesting piece is the SSE parser. `h3`'s `createEventStream` serialises a value containing newlines as multiple `data:` lines per SSE spec. A naïve "join lines without separator" collapses headings into following paragraphs (`"### Heading:- item1- item2"`). Per the spec, the data buffer joins each `data:` line with exactly one `\n`, and strips exactly one leading `U+0020 SPACE` (the field separator) from each line:

```ts
let data = ''
let hasData = false
for (const line of raw.split('\n')) {
  if (line.startsWith('event:')) event = line.slice(6).trim()
  else if (line.startsWith('data:')) {
    let value = line.slice(5)
    if (value.startsWith(' ')) value = value.slice(1)
    if (hasData) data += '\n'
    data += value
    hasData = true
  }
}
```

Same composable handles abort (so the user can stop a streaming answer mid-flight), session-switch (preserves message arrays per session id, hydrates from server on switch), and `tokens/sec` metering from the `done` event's totals over wall-clock elapsed time.

Local persistence in `localStorage`: session ids per workspace, optional focus state (entity / file / issue ids that pre-pin into every chat turn — plumbed end-to-end on the server side, exposed as composable methods, currently without an inline UI surface).

## Chat message rendering

[`app/components/ChatMessage.vue`](../app/components/ChatMessage.vue) takes a streamed Markdown string and produces:

1. Citation badges (`[chunk:UUID]` / `[entity:UUID]` markers from the LLM) become anchor elements that emit `open-chunk` / `open-entity` to the parent.
2. The Markdown is rendered with `marked`, sanitised with `DOMPurify`, mounted via `v-html`.
3. Two DOM post-processors run, both lazy-loaded on first use:

### Mermaid blocks

Walked by `querySelectorAll('pre > code.language-mermaid')`. For each:

- Lazy `import('mermaid')` on the first block ever (~250 KB chunk, paid once per app session).
- Render via `mermaid.render(uid, source)` to SVG.
- Sanitise the SVG with `DOMPurify` using the SVG profile (mermaid output is generated but the source text came from an LLM — never trust it raw).
- Replace the `<pre>` with a `<div class="cg-mermaid">` wrapper containing the cleaned SVG.
- Cache hit via `data-mermaid-rendered="1"` on the wrapper.

### Code blocks (every other language)

Walked by `querySelectorAll('pre > code[class*="language-"]')`, skipping mermaid:

- Lazy `import('shiki')` on first call.
- Map the markdown fence language (`ts`, `bash`, `yml`, `dockerfile`, `diff`, ...) to a Shiki grammar via a 30-language alias map.
- Call `codeToHtml(source, { lang, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false })`.
- Sanitise with `ADD_ATTR: ['style', 'class']` so Shiki's inline CSS-variable styles survive.
- Replace the `<pre>` with the Shiki one.

### Dual-theme via CSS variables (theme switching is pure CSS)

Shiki's single-theme output bakes background + token colours as inline `style="color: #X; background-color: #Y"`. After the user toggles the theme, those inline styles are stuck — the white pre-background sits on the dark surface. Dual-theme + `defaultColor: false` emits CSS variables on every span instead:

```html
<span style="--shiki-light: #008; --shiki-dark: #88f;">...</span>
```

A single global rule in [`app/assets/css/tailwind.css`](../app/assets/css/tailwind.css) maps them:

```css
.shiki, .shiki span {
  color: var(--shiki-light);
  background-color: var(--shiki-light-bg);
}
.dark .shiki, .dark .shiki span {
  color: var(--shiki-dark);
  background-color: var(--shiki-dark-bg);
}
```

`.dark` is the class `@nuxtjs/color-mode` puts on `<html>`. Theme switch is pure CSS — no re-render, no flash, no lag. The mermaid path uses `theme: 'neutral'` which renders fine on both themes without the same trick.

## Reasoning Inspector

[`app/components/ReasoningInspector.vue`](../app/components/ReasoningInspector.vue) renders the assistant's plan + trace. Two modes that share the same component:

### Planned mode — SVG flowchart

Input: `plan.steps[]` (from the planner) + `trace[]` (from the executor).

1. For each step, regex out `$sN` references from `step.params` to find its inputs.
2. Topo-sort by referenced steps so steps at level `1 + max(refs.levels)` lay out on a new row.
3. Lay out as a grid: 180×56 nodes, 8px gap between levels, centred horizontally per row.
4. Edges are SVG `path` elements with cubic bezier control points (`d="M x1 y1 C cx1 cy1, cx2 cy2, x2 y2"`).
5. Node fill colour by outcome from the trace: green = `ok`, red = `error`, violet = `stream` (the final `answer` step), grey = `pending`.
6. Click a node → details box below shows params (collapsible JSON) + result summary + error.

The list-mode fallback is the same data rendered as a vertical accordion — same `expanded` ref keys the open/closed state of step rows.

### Agentic mode — timeline

When the assistant ran in `Auto-explore` mode the trace shape is different — `{ mode: 'agentic', steps: [{ iteration, name, args, summary, durationMs, error? }] }`. The same component:

1. Discriminator computed: `agenticTrace` returns the envelope if `trace.mode === 'agentic'`, else null.
2. Groups steps by iteration (OpenAI parallel tools can put multiple calls in one round-trip).
3. Per-step row shows a status pill (✓ green / ! red), a tinted operator badge (colour-coded by family: lookup / traversal / search / retrieve / analysis / external), the inline result summary, and click-to-expand JSON.
4. The flowchart/list toggle is hidden in agentic mode (no DAG, just a sequence).

## Live streaming of agentic tool steps

The chat endpoint streams `event: tool_step` SSE events as each operator dispatches in agentic mode. `useChat` accumulates them into a live `AgenticTrace` so the Reasoning Inspector updates step-by-step as the model thinks, instead of waiting for the final `trace` snapshot. The final `trace` event still overwrites with the canonical version — that's the authoritative copy persisted to the database.

## Tour overlay

[`app/components/WorkspaceOnboarding.vue`](../app/components/WorkspaceOnboarding.vue) is the first-visit overlay. State:

- `showOnboarding` ref, written from a watcher on `isReady` that reads `localStorage.getItem(\`cg-onb-seen-{workspaceId}\`)`. Auto-opens on first visit to a ready workspace; subsequent visits don't.
- Reopen button in the workspace header resets the flag and toggles the modal.
- Fetches in two waves: synchronous `useFetch` on `/api/workspaces/:id/onboarding` (entrypoints + abstractions + good-first-PR zones); lazy parallel fetches on mount for `/github-issues` (Octokit-anonymous, can be slow) and `/setup-guide` (cheap, DB-only).
- Esc closes; click on backdrop closes.

Each section emits one of `walkthrough` / `open-entity` / `ask` to the parent. The parent (the workspace page) wires these into the chat — `walkthrough` prefills the input with "Walk me through {name} step by step" and submits; `open-entity` opens the neighbour graph drawer; `ask` prefills a question template like "Explain what {path} does and what a first contributor could realistically improve there."

## Neighbour graph drawer

[`app/components/EntityNeighbourGraph.vue`](../app/components/EntityNeighbourGraph.vue) — Sigma.js + Graphology centred on a single entity at 1- or 2-hop depth. Concentric layout: focus at origin, depth-1 neighbours on a 80px ring, depth-2 on 160px. Node colour by entity type from a small palette tuned for both themes (`commit`, `variable`, `module` are the troublesome ones — too light on dark, too dark on light, picked mid-lightness shades).

The drawer also doubles as a Call Hierarchy view (toggle in the header) — a text-only tree of callers / callees / tests / parents, lazy-expanded one level at a time. Used internally by the agentic walkthrough rendering, and exposed as an alternate view for users who prefer reading lists to looking at force-graphs.

## Treemap

[`app/components/WorkspaceTreemap.vue`](../app/components/WorkspaceTreemap.vue) — `d3-hierarchy` + `d3.treemap`. Three preset metrics:

- **LOC** — file size by entity count (proxy for "how big is this file's responsibility").
- **Hotness** — `metadata.hotness` from the git-history step (commits in the last 90 days).
- **Coverage** — `1` if the file has an inbound `tested_by` relation, else `0`.

`ResizeObserver` triggers re-layout. Hover tooltip with file path + metrics. Click a leaf → emits `focus(entityId)` which opens the neighbour drawer in the parent layout.

## Chunk citation flow

When the model writes `[chunk:UUID]` in its answer, that's a marker. `ChatMessage.vue` replaces the marker with an anchor (`<a class="cg-cite" data-id="...">`). Click on the anchor → emit `open-chunk(id)` to parent → parent opens [`SourceViewerDrawer.vue`](../app/components/SourceViewerDrawer.vue) with that chunk id.

The viewer:

1. Fetches `/api/workspaces/:id/chunk/:chunkId`.
2. If the chunk is a diff chunk (per-commit) AND a source-code chunk exists for the same path → auto-swaps to the source chunk by default and remembers the diff id (a small "Diff" button flips back). Users complained that citations almost always landed them on a diff when they wanted to read the file.
3. Renders the chunk text via Shiki (dual-theme, same setup as chat) with language inferred from `metadata.language` + filename extension chain (so `foo.config.ts` highlights as `typescript`).
4. Markdown chunks render via `marked` + `DOMPurify` into a `.cg-prose` container.
5. Diff chunks render with Shiki's `diff` grammar.

## Cursor affordance

A small thing, but Tailwind 4's reset ships interactive elements with `cursor: default` — every `<Button>` / `<a>` / `[role=button]` rendered with the text cursor and felt inert. One global block in [`app/assets/css/tailwind.css`](../app/assets/css/tailwind.css) restores the pointer for everything clickable and switches to `not-allowed` for disabled variants. Text inputs / textareas are deliberately excluded — the I-beam caret is the right affordance for text entry.

## Bilingual UX

[`i18n/locales/en.json`](../i18n/locales/en.json) and [`ru.json`](../i18n/locales/ru.json) are maintained in lockstep. Tip if you add a key: edit both files in the same commit — there's no auto-fallback, missing keys render as the key string. The system prompts for chat (system prompts in `server/kag/operators/answer.ts` and `server/kag/agentic.ts`) carry both EN and RU variants and pick by `body.locale`.

## Files to read

- App shell + global CSS: [`app/layouts/default.vue`](../app/layouts/default.vue), [`app/assets/css/tailwind.css`](../app/assets/css/tailwind.css)
- Chat composable: [`app/composables/useChat.ts`](../app/composables/useChat.ts)
- Chat message: [`app/components/ChatMessage.vue`](../app/components/ChatMessage.vue)
- Reasoning Inspector: [`app/components/ReasoningInspector.vue`](../app/components/ReasoningInspector.vue)
- Source Viewer drawer: [`app/components/SourceViewerDrawer.vue`](../app/components/SourceViewerDrawer.vue)
- Neighbour graph: [`app/components/EntityNeighbourGraph.vue`](../app/components/EntityNeighbourGraph.vue)
- Treemap: [`app/components/WorkspaceTreemap.vue`](../app/components/WorkspaceTreemap.vue)
- Tour overlay: [`app/components/WorkspaceOnboarding.vue`](../app/components/WorkspaceOnboarding.vue)
- Landing: [`app/components/LandingPage.vue`](../app/components/LandingPage.vue)
- Pages: [`app/pages/index.vue`](../app/pages/index.vue), [`app/pages/w/[id]/index.vue`](../app/pages/w/[id]/index.vue), [`app/pages/w/[id]/explore.vue`](../app/pages/w/[id]/explore.vue)
