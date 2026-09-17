<script setup>
defineProps({ title: { type: String, required: true }, wide: Boolean });
defineEmits(["close"]);
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="$emit('close')">
    <section class="modal-card" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
      <header class="modal-header">
        <h2>{{ title }}</h2>
        <button type="button" aria-label="Закрыть" @click="$emit('close')">×</button>
      </header>
      <div class="modal-body"><slot /></div>
      <footer v-if="$slots.footer" class="modal-footer"><slot name="footer" /></footer>
    </section>
  </div>
</template>
