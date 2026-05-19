<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Sun, Moon, Globe, Settings } from 'lucide-vue-next'

const colorMode = useColorMode()
const { loggedIn, user, clear } = useUserSession()
const { t, locale, locales, setLocale } = useI18n()

interface QuotaResponse {
  bypass: boolean
  viewerKind: 'user' | 'admin' | 'guest'
  limits: { workspacesPerDay: number; messagesPerDay: number; tokensPerDay: number }
  used: { workspaces: number; messages: number; tokens: number }
}

const isAdmin = computed(() => quota.value?.viewerKind === 'admin')

const { data: quota, refresh: refreshQuota } = useFetch<QuotaResponse>('/api/me/quota', {
  default: () => null as unknown as QuotaResponse,
})

// Refresh when login state flips so the pill updates after sign-in/out.
watch(() => loggedIn.value, () => void refreshQuota())
// Refresh whenever a chat turn completes — useChat bumps this counter
// after `done` so the pill reflects the token spend in near real time.
const quotaBump = useState<number>('quota-bump', () => 0)
watch(quotaBump, () => void refreshQuota())

const quotaPill = computed(() => {
  const q = quota.value
  if (!q || q.bypass) return null
  const tokensK = (n: number): string => `${Math.round(n / 1000)}k`
  return {
    messages: `${q.used.messages}/${q.limits.messagesPerDay}`,
    tokens: `${tokensK(q.used.tokens)}/${tokensK(q.limits.tokensPerDay)}`,
  }
})

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
  <div class="flex min-h-screen flex-col bg-background text-foreground">
    <header class="border-b border-border bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60">
      <div class="container mx-auto flex items-center justify-between px-4 py-3">
        <NuxtLink to="/" class="text-lg font-semibold tracking-tight">
          <span class="cg-gradient-text">{{ t('app.name') }}</span>
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
          <span
            v-if="quotaPill"
            class="hidden items-center gap-2 rounded-full border border-border bg-card/60 px-2.5 py-1 text-[11px] text-muted-foreground sm:inline-flex"
            :title="t('nav.quotaTitle')"
          >
            <span>{{ t('nav.quotaMessages') }}: {{ quotaPill.messages }}</span>
            <span class="text-border">·</span>
            <span>{{ t('nav.quotaTokens') }}: {{ quotaPill.tokens }}</span>
          </span>
          <InterestButton :bypass="quota?.bypass ?? false" />
          <template v-if="loggedIn">
            <NuxtLink v-if="isAdmin" to="/admin" class="hidden text-xs font-medium text-primary hover:underline sm:inline">
              {{ t('admin.title') }}
            </NuxtLink>
            <NuxtLink to="/settings" :title="t('nav.settings')">
              <Button variant="ghost" size="icon" :aria-label="t('nav.settings')">
                <Settings class="h-4 w-4" />
              </Button>
            </NuxtLink>
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
    <main class="container mx-auto flex flex-1 flex-col px-4 py-6 min-h-0">
      <slot />
    </main>
    <OnboardingOverlay />
  </div>
</template>
