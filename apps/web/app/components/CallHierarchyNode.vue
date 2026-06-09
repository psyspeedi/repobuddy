<script setup lang="ts">
/**
 * One row in the CallHierarchy tree. Recursive — renders nested
 * children once they're loaded. Indentation is computed from depth so
 * we don't need a global tree layout pass.
 */
import { ChevronRight, ChevronDown, GitFork, Bug, FileCode, Layers } from 'lucide-vue-next'

interface NodeRow {
  id: string
  type: string
  name: string
  qualifiedName: string | null
  filePath: string | null
  startLine: number | null
  endLine: number | null
  language: string | null
  depth: number
}
interface Child {
  node: NodeRow
  loaded: boolean
  expanded: boolean
  children: Child[]
  loading: boolean
}

interface Props {
  child: Child
  level: number
}
defineProps<Props>()
const emit = defineEmits<{
  (e: 'expand', c: Child): void
  (e: 'focus', id: string): void
}>()

function iconFor(type: string): typeof FileCode {
  if (type === 'function' || type === 'class' || type === 'type') return GitFork
  if (type === 'test') return Bug
  if (type === 'file') return FileCode
  return Layers
}
</script>

<template>
  <div class="space-y-0.5">
    <div
      class="flex items-center gap-1 rounded-md px-1.5 py-1 transition hover:bg-accent"
      :style="{ paddingLeft: `${level * 16 + 6}px` }"
    >
      <button
        type="button"
        class="inline-flex h-4 w-4 items-center justify-center text-muted-foreground hover:text-foreground"
        @click="emit('expand', child)"
      >
        <ChevronDown v-if="child.expanded" class="h-3 w-3" />
        <ChevronRight v-else class="h-3 w-3" />
      </button>
      <component :is="iconFor(child.node.type)" class="h-3 w-3 text-muted-foreground" />
      <button
        type="button"
        class="flex-1 truncate text-left font-mono text-xs hover:text-primary"
        :title="child.node.qualifiedName ?? child.node.name"
        @click="emit('focus', child.node.id)"
      >
        {{ child.node.name }}
      </button>
      <span class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ child.node.type }}</span>
    </div>
    <div v-if="child.expanded">
      <div v-if="child.loading" :style="{ paddingLeft: `${level * 16 + 26}px` }" class="text-[10px] italic text-muted-foreground">
        …
      </div>
      <div v-else-if="child.loaded && child.children.length === 0" :style="{ paddingLeft: `${level * 16 + 26}px` }" class="py-0.5 text-[10px] italic text-muted-foreground">
        ∅
      </div>
      <ul v-else-if="child.loaded" class="space-y-0.5">
        <li v-for="grand in child.children" :key="grand.node.id">
          <CallHierarchyNode
            :child="grand"
            :level="level + 1"
            @expand="(c) => emit('expand', c)"
            @focus="(id) => emit('focus', id)"
          />
        </li>
      </ul>
    </div>
  </div>
</template>
