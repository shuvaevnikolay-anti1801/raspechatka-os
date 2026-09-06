<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import { boot, canAccess } from "./api";
import TopNavigation from "./components/TopNavigation.vue";

const route = useRoute();
const can = canAccess;

const submenus = {
  dashboard: [{ label: "Обзор", to: "/", area: "dashboard" }],
  catalog: [
    { label: "Товары и услуги", to: "/catalog", area: "references.catalog" },
    { label: "Группы", to: "/catalog/groups", area: "references.catalog" },
    { label: "Единицы измерения", to: "/catalog/units", area: "references.catalog" },
    { label: "Типы цен", to: "/catalog/price-types", area: "references.catalog" },
  ],
  sales: [
    { label: "Точки продаж", to: "/sales", area: "sales.analytics" },
    { label: "Смены", to: "/sales/shifts", area: "sales.shifts" },
    { label: "Продажи", to: "/sales/receipts", area: "sales.receipts" },
    { label: "Возвраты", to: "/sales/returns", area: "sales.receipts" },
    { label: "Внесения и выплаты", to: "/sales/cash", area: "sales.cash" },
    { label: "Действия кассира", to: "/sales/actions", area: "sales.audit" },
    { label: "Подключение кассы", to: "/sales/integration", area: "sales.integration" },
  ],
  clients: [
    { label: "Клиенты", to: "/clients", area: "clients.base" },
    { label: "Клуб Распечатка", to: "/clients/club", area: "clients.loyalty" },
    { label: "Сегменты", to: "/clients/segments", area: "clients.marketing" },
    { label: "Рассылки", to: "/clients/campaigns", area: "clients.marketing" },
    { label: "Промокоды", to: "/clients/promo-codes", area: "clients.loyalty" },
    { label: "Календарь", to: "/clients/calendar", area: "clients.marketing" },
  ],
  warehouse: [
    { label: "Приёмки и оприходования", to: "/warehouse/receipts", area: "warehouse.operations" },
    { label: "Списания", to: "/warehouse/write-offs", area: "warehouse.operations" },
    { label: "Инвентаризации", to: "/warehouse/inventories", area: "warehouse.operations" },
    { label: "Заказы поставщикам", to: "/warehouse/purchase-orders", area: "warehouse.operations" },
    { label: "Остатки", to: "/warehouse/balances", area: "warehouse.operations" },
    { label: "Обороты", to: "/warehouse/turnover", area: "warehouse.operations" },
  ],
  team: [
    { label: "Сотрудники", to: "/team", area: "team.employees" },
    { label: "График", to: "/team/schedule", area: "team.schedule" },
    { label: "Зарплата", to: "/team/payroll", area: "team.payroll" },
    { label: "Премии и игра", to: "/team/bonuses", area: "team.motivation" },
    { label: "Кадры и документы", to: "/team/hr", area: "team.hr" },
  ],
  finance: [
    { label: "Обзор", to: "/finance", area: "finance.reporting" },
    { label: "Платежи", to: "/finance/payments", area: "finance.operations" },
    { label: "Платёжный календарь", to: "/finance/calendar", area: "finance.planning" },
    { label: "Финансовый отчёт", to: "/finance/report", area: "finance.reporting" },
    { label: "План и модель", to: "/finance/planning", area: "finance.planning" },
    { label: "Взаиморасчёты", to: "/finance/settlements", area: "finance.reporting" },
    { label: "Прибыльность", to: "/finance/profitability", area: "finance.reporting" },
    { label: "Точка Банк", to: "/finance/tochka", area: "finance.bank" },
  ],
  references: [
    { label: "Партнёры", to: "/references/organizations", area: "references.network" },
    { label: "Юридические лица", to: "/references/entities", area: "references.network" },
    { label: "Точки продаж", to: "/references/points", area: "references.network" },
    { label: "Склады", to: "/references/warehouses", area: "references.storage" },
    { label: "Поставщики", to: "/references/suppliers", area: "references.suppliers" },
    { label: "Сотрудники", to: "/references/employees", area: "references.employees" },
    { label: "Должности", to: "/references/positions", area: "references.employees" },
    { label: "Финансовые статьи", to: "/references/financial-articles", area: "references.finance" },
    { label: "Права доступа", to: "/settings/access", area: "settings.access", minimum: "Admin" },
  ],
};

const currentModule = computed(() => route.meta.module || route.params.module || "dashboard");
const currentSubmenu = computed(() => (submenus[currentModule.value] || []).filter((item) => typeof item === "string" || !item.area || can(item.area, item.minimum)));
const submenuItems = computed(() => currentSubmenu.value.map((item) => typeof item === "string" ? { label: item, to: null } : item));
</script>

<template>
  <div class="app-shell">
    <TopNavigation />

    <nav class="subnav" aria-label="Подразделы">
      <template v-for="(item, index) in submenuItems" :key="item.label">
        <router-link v-if="item.to" :to="item.to" :class="{ active: route.path === item.to }">{{ item.label }}</router-link>
        <button v-else type="button" :class="{ active: index === 0 }">{{ item.label }}</button>
      </template>
    </nav>

    <main class="workspace">
      <router-view />
    </main>
  </div>
</template>
