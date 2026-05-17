<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Sun, Moon, Globe } from 'lucide-vue-next'

const colorMode = useColorMode()
const { loggedIn, user, clear } = useUserSession()
const { t, locale, locales, setLocale } = useI18n()

function toggleTheme(): void {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}

async function logout(): Promise<void> {
  await $fetch('/api/auth/logout', { method: 'POST' })
  await clear()
  await navigateTo('/login')
}

const langMenuOpen = ref(false)
async function pickLocale(code: 'en' | 'ru'): Promise<void> {
  langMenuOpen.value = false
  await setLocale(code)
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <header class="border-b border-border bg-card">
      <div class="container mx-auto flex items-center justify-between px-4 py-3">
        <NuxtLink to="/" class="text-lg font-semibold tracking-tight">
          {{ t('app.name') }}
        </NuxtLink>
        <div class="flex items-center gap-2">
          <div class="relative">
            <Button
              variant="ghost"
              size="icon"
              :aria-label="t('nav.language')"
              :title="t('nav.language')"
              @click="langMenuOpen = !langMenuOpen"
            >
              <Globe class="h-4 w-4" />
            </Button>
            <div
              v-if="langMenuOpen"
              class="absolute right-0 top-10 z-50 min-w-[120px] overflow-hidden rounded-md border border-border bg-card shadow-md"
              @click.stop
            >
              <button
                v-for="loc in (locales as { code: string, name: string }[])"
                :key="loc.code"
                type="button"
                class="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                :class="loc.code === locale ? 'font-medium' : ''"
                @click="pickLocale(loc.code as 'en' | 'ru')"
              >
                {{ loc.name }}
              </button>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            :aria-label="colorMode.value === 'dark' ? t('nav.themeLight') : t('nav.themeDark')"
            :title="colorMode.value === 'dark' ? t('nav.themeLight') : t('nav.themeDark')"
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
              {{ t('nav.signOut') }}
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
