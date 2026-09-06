<script setup>
defineProps({ title: { type: String, required: true } });
</script>

<template>
  <header class="list-page-header">
    <h1>{{ title }}</h1>
    <div v-if="$slots.actions" class="list-page-actions"><slot name="actions" /></div>
  </header>
</template>
