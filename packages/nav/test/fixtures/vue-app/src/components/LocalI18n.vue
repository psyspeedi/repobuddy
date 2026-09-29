<template><p>{{ t('hello') }}</p></template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
</script>

<i18n lang="json">
{
  "en": { "hello": "Local hello" },
  "ru": { "hello": "Локальный привет" }
}
</i18n>
