<script setup lang="ts">
// The legacy global Sigma.js graph was removed in favour of the
// treemap-driven /explore page + per-entity Neighbour Graph drawer.
// This route stays as a permanent redirect so external links and
// bookmarks (e.g. sitemap entries) keep working.
const route = useRoute()
const workspaceId = route.params.id as string
const target = `/w/${workspaceId}/explore`

if (import.meta.server) {
  await navigateTo(target, { redirectCode: 308, replace: true })
} else {
  onMounted(() => {
    void navigateTo(target, { replace: true })
  })
}
</script>

<template>
  <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
    <p>{{ $t('graph.redirecting') }}</p>
  </div>
</template>
