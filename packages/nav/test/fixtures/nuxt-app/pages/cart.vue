<template>
  <div>
    <h1>{{ $t('cart.title') }}</h1>
    <BaseButton :label="$t('cart.checkout')" />
  </div>
</template>

<script setup lang="ts">
const { items } = useCart();
</script>
