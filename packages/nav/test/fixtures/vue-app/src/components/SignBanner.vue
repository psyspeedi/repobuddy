<template><div class="banner" aria-label="Баннер договора">{{ tr('sign') }}</div></template>
<script setup lang="ts">
import { useGetTranslation } from '@/composables/useGetTranslation';
const scope = 'pages.group.banner';
const tr = useGetTranslation(scope);
</script>
