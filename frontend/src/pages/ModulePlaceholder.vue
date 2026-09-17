<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";

const route = useRoute();
const labels = { orders: "Заказы", clients: "Клиенты", warehouse: "Склад", team: "Команда", finance: "Финансы", analytics: "Аналитика" };
const title = computed(() => labels[route.params.module] || "Раздел");
</script>

<template>
  <section class="page placeholder-page">
    <div class="eyebrow">РАСПЕЧАТКА ОС</div>
    <h1>{{ title }}</h1>
    <div class="placeholder-card"><span>СЛЕДУЮЩИЙ МОДУЛЬ</span><h2>Раздел готов к разработке</h2><p>Навигация и единый дизайн уже работают. Содержимое этого модуля добавим следующим этапом.</p></div>
  </section>
</template>
