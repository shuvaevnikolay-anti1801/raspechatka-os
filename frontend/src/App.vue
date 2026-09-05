<script setup>
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { boot, canAccess } from "./api";

const route = useRoute();
const mobileOpen = ref(false);
const can = canAccess;

const modules = [
  { key: "dashboard", label: "Главная", to: "/", area: "dashboard" },
  { key: "orders", label: "Заказы", to: "/orders" },
  { key: "clients", label: "Клиенты", to: "/clients" },
  { key: "references", label: "Справочники", to: "/references/entities", area: "references" },
  { key: "catalog", label: "Каталог", to: "/catalog", area: "references.catalog" },
  { key: "warehouse", label: "Склад", to: "/warehouse" },
  { key: "team", label: "Команда", to: "/team" },
  { key: "finance", label: "Финансы", to: "/finance" },
  { key: "analytics", label: "Аналитика", to: "/analytics" },
];

const submenus = {
  dashboard: ["Обзор", "Продажи", "Точки"],
  catalog: [
    { label: "Товары и услуги", to: "/catalog", area: "references.catalog" },
    { label: "Группы", to: "/catalog/groups", area: "references.catalog" },
    { label: "Единицы измерения", to: "/catalog/units", area: "references.catalog" },
    { label: "Типы цен", to: "/catalog/price-types", area: "references.catalog" },
  ],
  orders: ["Все заказы", "В работе", "Готовы", "История"],
  clients: ["Клиенты", "Сегменты", "Лояльность"],
  warehouse: ["Остатки", "Приходы", "Перемещения", "Списания", "Инвентаризации"],
  team: ["Сотрудники", "Обучение", "График"],
  finance: ["Обзор", "Кассы", "Платежи", "Зарплата"],
  analytics: ["Показатели", "Отчёты", "Конструктор"],
  references: [
    { label: "Партнёры", to: "/references/organizations", area: "references.network" },
    { label: "Юридические лица", to: "/references/entities", area: "references.network" },
    { label: "Точки продаж", to: "/references/points", area: "references.network" },
    { label: "Склады", to: "/references/warehouses", area: "references.storage" },
    { label: "Клиенты", to: "/references/clients", area: "references.clients" },
    { label: "Поставщики", to: "/references/suppliers", area: "references.suppliers" },
    { label: "Сотрудники", to: "/references/employees", area: "references.employees" },
    { label: "Должности", to: "/references/positions", area: "references.employees" },
    { label: "Финансовые статьи", to: "/references/financial-articles", area: "references.finance" },
    { label: "Права доступа", to: "/settings/access", area: "settings.access", minimum: "Admin" },
  ],
};

const currentModule = computed(() => route.meta.module || route.params.module || "dashboard");
const visibleModules = computed(() => modules.filter((item) => item.area !== "references" ? (!item.area || can(item.area)) : Object.keys(boot.access || {}).some((area) => area.startsWith("references.") && can(area))));
const currentSubmenu = computed(() => (submenus[currentModule.value] || []).filter((item) => typeof item === "string" || !item.area || can(item.area, item.minimum)));
const submenuItems = computed(() => currentSubmenu.value.map((item) => typeof item === "string" ? { label: item, to: null } : item));
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
          v-for="item in visibleModules"
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
      <template v-for="(item, index) in submenuItems" :key="item.label">
        <router-link v-if="item.to" :to="item.to" :class="{ active: route.path === item.to }">{{ item.label }}</router-link>
        <button v-else type="button" :class="{ active: index === 0 }">{{ item.label }}</button>
      </template>
    </nav>

    <div v-if="mobileOpen" class="mobile-nav">
      <router-link v-for="item in visibleModules" :key="item.key" :to="item.to" @click="mobileOpen = false">
        {{ item.label }}
      </router-link>
    </div>

    <main class="workspace">
      <router-view />
    </main>
  </div>
</template>
