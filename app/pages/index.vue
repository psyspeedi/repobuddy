<script setup lang="ts">
useHead({ title: 'CodeGraph — Workspaces' })

const { user } = useUserSession()
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold">
          Workspaces
        </h1>
        <p class="text-sm text-muted-foreground">
          Signed in as <span class="font-medium">{{ user?.login }}</span>
        </p>
      </div>
    </div>

    <div class="rounded-lg border border-dashed border-border bg-card p-6 text-center">
      <p class="text-sm text-muted-foreground">
        No workspaces yet. Workspace creation is wired in phase 1.5.
      </p>
    </div>
  </div>
</template>
