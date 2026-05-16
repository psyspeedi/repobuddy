<script setup lang="ts">
import { codeToHtml } from 'shiki'
import { Button } from '@/components/ui/button'

interface Props {
  workspaceId: string
  chunkId: string | null
}
const props = defineProps<Props>()
defineEmits<{ (e: 'close'): void }>()

const colorMode = useColorMode()

interface ChunkResponse {
  chunk: {
    id: string
    text: string
    filePath: string | null
    startLine: number | null
    endLine: number | null
    metadata: { language?: string } | null
  }
}

const data = ref<ChunkResponse | null>(null)
const html = ref<string>('')
const loading = ref(false)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  if (!props.chunkId) return
  loading.value = true
  error.value = null
  try {
    data.value = await $fetch<ChunkResponse>(
      `/api/workspaces/${props.workspaceId}/chunk/${props.chunkId}`,
    )
    const lang = data.value.chunk.metadata?.language ?? 'plaintext'
    html.value = await codeToHtml(data.value.chunk.text, {
      lang: shikiLang(lang),
      theme: colorMode.value === 'dark' ? 'github-dark' : 'github-light',
    })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

watch(() => props.chunkId, () => void load(), { immediate: true })
watch(() => colorMode.value, () => void load())

function shikiLang(lang: string): string {
  if (lang === 'typescript' || lang === 'javascript' || lang === 'python' || lang === 'go') return lang
  return 'plaintext'
}
</script>

<template>
  <aside class="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-card">
    <header class="flex items-center justify-between border-b border-border px-3 py-2">
      <div class="text-sm">
        <p v-if="data?.chunk" class="font-mono">
          {{ data.chunk.filePath }}
          <span v-if="data.chunk.startLine" class="text-muted-foreground">
            :{{ data.chunk.startLine }}-{{ data.chunk.endLine }}
          </span>
        </p>
        <p v-else class="text-muted-foreground">
          Source viewer
        </p>
      </div>
      <Button variant="ghost" size="sm" @click="$emit('close')">
        ×
      </Button>
    </header>
    <div class="flex-1 overflow-auto p-3 text-xs">
      <div v-if="loading">
        Loading…
      </div>
      <p v-else-if="error" class="text-destructive">
        {{ error }}
      </p>
      <div v-else v-html="html" />
    </div>
  </aside>
</template>
