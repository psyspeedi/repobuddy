<script setup lang="ts">
import type { ChatSessionListItem } from '@/composables/useChatSessions'

interface Props {
  sessions: ChatSessionListItem[]
  activeSessionId: string
  loading?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'delete', id: string): void
  (e: 'new'): void
}>()
const { t } = useI18n()

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return t('time.justNow')
  if (m < 60) return t('time.minutesAgo', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('time.hoursAgo', { n: h })
  const d = Math.floor(h / 24)
  return t('time.daysAgo', { n: d })
}

function isActive(id: string): boolean {
  return id === props.activeSessionId
}

async function onDelete(e: MouseEvent, id: string): Promise<void> {
  e.stopPropagation()
  emit('delete', id)
}
</script>

<template>
  <aside class="flex h-full w-52 shrink-0 flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card p-2">
    <div class="flex items-center justify-between gap-1 px-1">
      <h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {{ t('chat.chats') }}
      </h2>
      <Button variant="ghost" size="sm" @click="emit('new')">
        {{ t('chat.newChat') }}
      </Button>
    </div>
    <ul class="flex-1 space-y-1 overflow-y-auto pr-1">
      <li v-if="sessions.length === 0 && !loading" class="px-2 py-3 text-center text-xs text-muted-foreground">
        {{ t('chat.noChats') }}
      </li>
      <li
        v-for="s in sessions"
        :key="s.id"
        class="group cursor-pointer rounded-md px-2 py-2 text-xs transition"
        :class="
          isActive(s.id)
            ? 'bg-accent text-accent-foreground'
            : 'hover:bg-muted'
        "
        @click="emit('select', s.id)"
      >
        <div class="flex items-start justify-between gap-1">
          <div class="min-w-0 flex-1 space-y-0.5">
            <p class="truncate text-sm font-medium">
              {{ s.title || t('chat.untitled') }}
            </p>
            <p v-if="s.preview" class="line-clamp-2 text-muted-foreground">
              {{ s.preview }}
            </p>
            <p class="text-[10px] uppercase tracking-wide text-muted-foreground">
              {{ t('chat.messageCount', { n: s.messageCount }) }} · {{ relativeTime(s.updatedAt) }}
            </p>
          </div>
          <button
            type="button"
            class="invisible h-5 w-5 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:visible"
            :title="t('chat.deleteChat')"
            @click="onDelete($event, s.id)"
          >
            ×
          </button>
        </div>
      </li>
    </ul>
  </aside>
</template>
