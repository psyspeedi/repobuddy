<template><span>{{ $t(`status.${code}`) }}</span></template>
<script setup lang="ts">
defineProps<{ code: string }>();
</script>
