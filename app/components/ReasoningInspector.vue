<script setup lang="ts">
import type { PlanData, TraceEntry } from '@/composables/useChat'

interface Props {
  plan: PlanData | null | undefined
  trace: TraceEntry[] | null | undefined
}
const props = defineProps<Props>()
const expanded = ref<Record<string, boolean>>({})

function toggle(id: string): void {
  expanded.value[id] = !expanded.value[id]
}

const indexedSteps = computed(() => {
  if (!props.plan) return []
  return props.plan.steps.map((step) => {
    const traceEntry = props.trace?.find((t) => t.stepId === step.id) ?? null
    return { step, trace: traceEntry }
  })
})
</script>

<template>
  <aside class="flex h-full w-full flex-col gap-3 overflow-hidden rounded-lg border border-border bg-card p-3">
    <header class="space-y-1">
      <h2 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Reasoning
      </h2>
      <p v-if="plan" class="text-xs text-muted-foreground">
        {{ plan.reasoning }}
      </p>
    </header>

    <ul v-if="plan" class="flex-1 space-y-1 overflow-y-auto pr-1">
      <li
        v-for="(entry, i) in indexedSteps"
        :key="entry.step.id"
        class="rounded-md border border-border"
      >
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-accent"
          @click="toggle(entry.step.id)"
        >
          <span class="flex items-center gap-2">
            <span
              class="inline-flex h-5 w-5 items-center justify-center rounded-full text-xs"
              :class="
                entry.trace
                  ? entry.trace.ok
                    ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                    : 'bg-destructive/15 text-destructive'
                  : 'bg-muted text-muted-foreground'
              "
            >{{ i + 1 }}</span>
            <code class="text-sm">{{ entry.step.op }}</code>
            <span class="text-xs text-muted-foreground">{{ entry.step.id }}</span>
          </span>
          <span class="text-xs text-muted-foreground">
            {{ entry.trace?.durationMs != null ? entry.trace.durationMs + 'ms' : '—' }}
          </span>
        </button>
        <div v-if="expanded[entry.step.id]" class="border-t border-border bg-muted/30 px-3 py-2 text-xs">
          <p v-if="entry.step.comment" class="mb-1 italic text-muted-foreground">
            {{ entry.step.comment }}
          </p>
          <details class="mb-2">
            <summary class="cursor-pointer select-none text-muted-foreground">
              params
            </summary>
            <pre class="mt-1 whitespace-pre-wrap break-all">{{ JSON.stringify(entry.step.params, null, 2) }}</pre>
          </details>
          <p v-if="entry.trace?.summary" class="text-muted-foreground">
            <span class="font-medium">result:</span> <code>{{ entry.trace.summary }}</code>
          </p>
          <p v-if="entry.trace?.error" class="text-destructive">
            error: {{ entry.trace.error }}
          </p>
        </div>
      </li>
    </ul>

    <p v-else class="text-sm text-muted-foreground">
      No plan yet — ask a question.
    </p>
  </aside>
</template>
