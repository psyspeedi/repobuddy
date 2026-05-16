<script setup lang="ts">
import { Button } from '@/components/ui/button'

const colorMode = useColorMode()

function toggleTheme(): void {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <header class="border-b border-border bg-card">
      <div class="container mx-auto flex items-center justify-between px-4 py-3">
        <NuxtLink to="/" class="text-lg font-semibold tracking-tight">
          CodeGraph
        </NuxtLink>
        <Button
          variant="outline"
          size="sm"
          aria-label="Toggle theme"
          @click="toggleTheme"
        >
          {{ colorMode.value === 'dark' ? 'Light' : 'Dark' }}
        </Button>
      </div>
    </header>
    <main class="container mx-auto px-4 py-6">
      <slot />
    </main>
  </div>
</template>
