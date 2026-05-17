<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Sun, Moon } from 'lucide-vue-next'

const colorMode = useColorMode()
const { loggedIn, user, clear } = useUserSession()

function toggleTheme(): void {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}

async function logout(): Promise<void> {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  await navigateTo('/login')
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <header class="border-b border-border bg-card">
      <div class="container mx-auto flex items-center justify-between px-4 py-3">
        <NuxtLink to="/" class="text-lg font-semibold tracking-tight">
          CodeGraph
        </NuxtLink>
        <div class="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            :aria-label="colorMode.value === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
            :title="colorMode.value === 'dark' ? 'Light theme' : 'Dark theme'"
            @click="toggleTheme"
          >
            <Sun v-if="colorMode.value === 'dark'" class="h-4 w-4" />
            <Moon v-else class="h-4 w-4" />
          </Button>
          <template v-if="loggedIn">
            <span class="hidden text-sm text-muted-foreground sm:inline">
              {{ user?.login }}
            </span>
            <Button variant="ghost" size="sm" @click="logout">
              Sign out
            </Button>
          </template>
        </div>
      </div>
    </header>
    <main class="container mx-auto px-4 py-6">
      <slot />
    </main>
  </div>
</template>
