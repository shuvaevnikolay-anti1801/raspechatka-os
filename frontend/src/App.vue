<script setup>
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { boot } from "./api";

const route = useRoute();
const mobileOpen = ref(false);

const modules = [
  { key: "dashboard", label: "Главная", to: "/" },
  { key: "orders", label: "Заказы", to: "/orders" },
  { key: "clients", label: "Клиенты", to: "/clients" },
  { key: "catalog", label: "Каталог", to: "/catalog" },
  { key: "warehouse", label: "Склад", to: "/warehouse" },
  { key: "team", label: "Команда", to: "/team" },
  { key: "finance", label: "Финансы", to: "/finance" },
  { key: "analytics", label: "Аналитика", to: "/analytics" },
];

const submenus = {
  dashboard: ["Обзор", "Продажи", "Точки"],
  catalog: ["Товары и услуги", "Группы", "Цены", "Ассортимент", "Поставщики"],
  orders: ["Все заказы", "В работе", "Готовы", "История"],
  clients: ["Клиенты", "Сегменты", "Лояльность"],
  warehouse: ["Остатки", "Приходы", "Перемещения", "Списания", "Инвентаризации"],
  team: ["Сотрудники", "Обучение", "График"],
  finance: ["Обзор", "Кассы", "Платежи", "Зарплата"],
  analytics: ["Показатели", "Отчёты", "Конструктор"],
};

const currentModule = computed(() => route.meta.module || route.params.module || "dashboard");
const currentSubmenu = computed(() => submenus[currentModule.value] || []);
const initials = computed(() => (boot.full_name || boot.user || "Р").trim().slice(0, 1).toUpperCase());
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <router-link class="brand" to="/" aria-label="Распечатка ОС — главная">
        <img :src="'/assets/raspechatka/images/raspechatka-brand.svg'" alt="" />
        <span>Распечатка <b>ОС</b></span>
      </router-link>

      <nav class="main-nav" aria-label="Основные разделы">
        <router-link
          v-for="item in modules"
          :key="item.key"
          :to="item.to"
          :class="{ active: currentModule === item.key }"
        >{{ item.label }}</router-link>
      </nav>

      <div class="topbar-actions">
        <button class="location-button" type="button" title="Текущая точка">
          <span class="status-dot"></span>
          <span class="location-label">Все точки</span>
          <span aria-hidden="true">⌄</span>
        </button>
        <button class="icon-button" type="button" aria-label="Поиск">⌕</button>
        <button class="avatar" type="button" :title="boot.full_name">{{ initials }}</button>
        <button class="menu-button" type="button" @click="mobileOpen = !mobileOpen" aria-label="Открыть меню">☰</button>
      </div>
    </header>

    <nav class="subnav" aria-label="Подразделы">
      <button
        v-for="(item, index) in currentSubmenu"
        :key="item"
        type="button"
        :class="{ active: index === 0 }"
      >{{ item }}</button>
    </nav>

    <div v-if="mobileOpen" class="mobile-nav">
      <router-link v-for="item in modules" :key="item.key" :to="item.to" @click="mobileOpen = false">
        {{ item.label }}
      </router-link>
    </div>

    <main class="workspace">
      <router-view />
    </main>
  </div>
</template>
