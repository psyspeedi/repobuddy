<template>
  <section>
    <h2>{{ t('tabs.grades') }}</h2>
    <MButton :label="t('back')" />
  </section>
</template>

<script setup lang="ts">
import { useGetTranslation } from '@/composables/useGetTranslation';
import { api } from '@/api';

const t = useGetTranslation('common');
const { getGrades } = api.modules.v3.teacher.groups;
getGrades(1);
</script>
