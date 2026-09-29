<template>
  <div>
    <h1>{{ $t(`${localePrefix}.title`) }}</h1>
    <p>{{ $t(`${localePrefix}.reports.vk.chats`) }}</p>
    <GradesTab />
    <SignBanner />
  </div>
</template>

<script lang="ts">
import GradesTab from '@ui/GradesTab.vue';
import SignBanner from '@/components/SignBanner.vue';
import { api } from '@/api';

const localePrefix = 'pages.group';

export default {
  components: { GradesTab, SignBanner },
  data: () => ({ localePrefix }),
  mounted() {
    api.modules.v3.teacher.groups.getGroup(1);
  },
};
</script>
