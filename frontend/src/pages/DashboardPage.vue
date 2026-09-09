<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { call } from "../api";

const router = useRouter();
const loading = ref(true);
const error = ref("");
const data = reactive({
  filters: { entities: [], points: [] },
  period: {},
  metrics: {},
  alerts: [],
  dynamics: [],
  points: [],
  upcoming_events: [],
});
const filters = reactive({
  period: "today",
  from_date: "",
  to_date: "",
  business_entity: "",
  city: "",
  business_point: "",
});
let timer;

const availableCities = computed(() => [
  ...new Set(
    data.filters.points
      .filter((row) => !filters.business_entity || row.business_entity === filters.business_entity)
      .map((row) => row.city)
      .filter(Boolean),
  ),
]);
const availablePoints = computed(() =>
  data.filters.points.filter(
    (row) =>
      (!filters.business_entity || row.business_entity === filters.business_entity) &&
      (!filters.city || row.city === filters.city),
  ),
);
const chartMax = computed(() => Math.max(...data.dynamics.map((row) => Number(row.value || 0)), 1));
const periodLabel = computed(
  () =>
    ({ today: "Сегодня", yesterday: "Вчера", week: "Эта неделя", month: "Этот месяц" })[filters.period] ||
    `${data.period.from_date || ""} — ${data.period.to_date || ""}`,
);
const money = (value) =>
  `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Number(value || 0))} ₽`;
const number = (value) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Number(value || 0));
const percent = (value, signed = false) =>
  value === null || value === undefined
    ? "—"
    : `${signed && value > 0 ? "+" : ""}${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value)}%`;

async function load(silent = false) {
  if (!silent) loading.value = true;
  error.value = "";
  try {
    Object.assign(data, await call("raspechatka.api.dashboard.get_control_center", filters));
  } catch (exception) {
    error.value = exception.message;
  } finally {
    loading.value = false;
  }
}
function changeEntity() {
  filters.city = "";
  filters.business_point = "";
  load();
}
function changeCity() {
  filters.business_point = "";
  load();
}
function selectPoint(name) {
  filters.business_point = name;
  load();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function openRoute(path) {
  router.push({
    path,
    query: {
      business_point: filters.business_point || undefined,
      from_date: data.period.from_date,
      to_date: data.period.to_date,
    },
  });
}
onMounted(async () => {
  await load();
  timer = window.setInterval(() => load(true), 60000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <section class="page control-center">
    <div class="page-heading control-heading"><div><h1>Центр управления</h1></div></div>

    <div class="control-filters">
      <select v-model="filters.period" aria-label="Период" @change="load()">
        <option value="today">Сегодня</option>
        <option value="yesterday">Вчера</option>
        <option value="week">Эта неделя</option>
        <option value="month">Этот месяц</option>
        <option value="custom">Свой период</option>
      </select>
      <template v-if="filters.period === 'custom'">
        <input v-model="filters.from_date" type="date" aria-label="Дата начала" @change="load()" />
        <input v-model="filters.to_date" type="date" aria-label="Дата окончания" @change="load()" />
      </template>
      <select v-model="filters.business_entity" aria-label="Организация" @change="changeEntity">
        <option value="">Все организации</option>
        <option v-for="row in data.filters.entities" :key="row.name" :value="row.name">{{ row.short_name || row.name }}</option>
      </select>
      <select v-model="filters.city" aria-label="Город" @change="changeCity">
        <option value="">Все города</option>
        <option v-for="city in availableCities" :key="city" :value="city">{{ city }}</option>
      </select>
      <select v-model="filters.business_point" aria-label="Точка продаж" @change="load()">
        <option value="">Все точки</option>
        <option v-for="row in availablePoints" :key="row.name" :value="row.name">{{ row.point_name }}</option>
      </select>
    </div>

    <div v-if="loading" class="table-message"><span class="loader"></span><span>Собираем показатели…</span></div>
    <div v-else-if="error" class="table-message error-message">
      <strong>Не удалось загрузить данные</strong><span>{{ error }}</span><button @click="load()">Повторить</button>
    </div>
    <template v-else>
      <div class="control-metrics">
        <article>
          <small>ВЫРУЧКА</small><b>{{ money(data.metrics.revenue?.value) }}</b>
          <div><span :class="{ positive: data.metrics.revenue?.delta > 0, negative: data.metrics.revenue?.delta < 0 }">{{ percent(data.metrics.revenue?.delta, true) }}</span> к прошлому периоду</div>
          <footer v-if="data.metrics.revenue?.plan"><span>План {{ money(data.metrics.revenue.plan) }}</span><strong>{{ percent(data.metrics.revenue.attainment) }}</strong></footer>
          <footer v-else><span>План не задан</span><router-link to="/finance/planning">Настроить</router-link></footer>
        </article>
        <article>
          <small>ВАЛОВАЯ ПРИБЫЛЬ</small><b>{{ money(data.metrics.profit?.value) }}</b>
          <div>Маржа <strong>{{ percent(data.metrics.profit?.margin) }}</strong></div>
          <footer><span>К прошлому периоду</span><strong>{{ percent(data.metrics.profit?.delta, true) }}</strong></footer>
        </article>
        <article>
          <small>ЧЕКИ</small><b>{{ number(data.metrics.receipts?.value) }}</b>
          <div>Возвраты <strong>{{ number(data.metrics.receipts?.returns) }}</strong></div>
          <footer v-if="data.metrics.receipts?.plan"><span>План {{ number(data.metrics.receipts.plan) }}</span><strong>{{ percent(data.metrics.receipts.attainment) }}</strong></footer>
          <footer v-else><span>План не задан</span><router-link to="/finance/planning">Настроить</router-link></footer>
        </article>
        <article>
          <small>СРЕДНИЙ ЧЕК</small><b>{{ money(data.metrics.average_check?.value) }}</b>
          <div><span :class="{ positive: data.metrics.average_check?.delta > 0, negative: data.metrics.average_check?.delta < 0 }">{{ percent(data.metrics.average_check?.delta, true) }}</span> к прошлому периоду</div>
          <footer v-if="data.metrics.average_check?.plan"><span>План {{ money(data.metrics.average_check.plan) }}</span><strong>{{ percent(data.metrics.average_check.attainment) }}</strong></footer>
          <footer v-else><span>План не задан</span><router-link to="/finance/planning">Настроить</router-link></footer>
        </article>
      </div>

      <div class="control-layout">
        <article class="control-panel alerts-panel">
          <header><div><small>ТРЕБУЕТ ВНИМАНИЯ</small><h2>Отклонения и задачи</h2></div><span :class="['count-badge', { active: data.alerts.length }]">{{ data.alerts.length }}</span></header>
          <div v-if="data.alerts.length" class="alert-list">
            <button v-for="alert in data.alerts" :key="`${alert.title}-${alert.business_point}-${alert.message}`" :class="['alert-row', alert.level]" @click="openRoute(alert.route)">
              <i></i><span><b>{{ alert.title }}</b><small>{{ alert.message }}</small></span><em>→</em>
            </button>
          </div>
          <div v-else class="control-empty"><b>Критичных отклонений нет</b><span>Остатки, поставки, платежи, кассы и банковские операции в норме.</span></div>
        </article>

        <article class="control-panel dynamics-panel">
          <header><div><small>ВЫРУЧКА · {{ periodLabel.toUpperCase() }}</small><h2>Динамика</h2></div><b>{{ money(data.metrics.revenue?.value) }}</b></header>
          <div v-if="data.dynamics.length" class="control-chart">
            <div v-for="row in data.dynamics" :key="row.label" class="control-bar">
              <span :style="{ height: `${Math.max((Number(row.value) / chartMax) * 100, 3)}%` }" :title="money(row.value)"></span><small>{{ row.label }}</small>
            </div>
          </div>
          <div v-else class="control-empty"><b>Продаж за период нет</b><span>График появится после проведения первого чека.</span></div>
        </article>
      </div>

      <article class="control-panel points-table">
        <header><div><small>ТОЧКИ ПРОДАЖ</small><h2>Сравнение результатов</h2></div><span>{{ data.points.length }} точек</span></header>
        <div class="table-shell">
          <table>
            <thead><tr><th>Точка</th><th>Город</th><th>Выручка</th><th>План</th><th>Динамика</th><th>Чеки</th><th>Средний чек</th><th>Маржа</th><th>Сигналы</th></tr></thead>
            <tbody><tr v-for="row in data.points" :key="row.name" tabindex="0" @click="selectPoint(row.name)" @keydown.enter="selectPoint(row.name)">
              <td class="item-name">{{ row.point_name }}</td><td>{{ row.city || "—" }}</td><td class="number-cell">{{ money(row.revenue) }}</td><td class="number-cell">{{ percent(row.plan_attainment) }}</td>
              <td :class="['number-cell', { positive: row.delta > 0, negative: row.delta < 0 }]">{{ percent(row.delta, true) }}</td><td class="number-cell">{{ number(row.receipts) }}</td>
              <td class="number-cell">{{ money(row.average_check) }}</td><td class="number-cell">{{ percent(row.margin) }}</td><td><span :class="['signal-badge', { active: row.alerts }]">{{ row.alerts }}</span></td>
            </tr></tbody>
          </table>
          <div v-if="!data.points.length" class="table-message"><strong>Нет доступных точек</strong><span>Проверьте область доступа пользователя и настройки точек продаж.</span></div>
        </div>
      </article>

      <article class="control-panel events-panel">
        <header><div><small>БЛИЖАЙШИЕ 7 ДНЕЙ</small><h2>Поставки и платежи</h2></div></header>
        <div v-if="data.upcoming_events.length" class="control-event-list">
          <button v-for="event in data.upcoming_events" :key="`${event.type}-${event.title}-${event.date}`" @click="openRoute(event.route)">
            <time>{{ event.date }}</time><span><small>{{ event.type }} · {{ event.business_point }}</small><b>{{ event.title }}</b></span><em>→</em>
          </button>
        </div>
        <div v-else class="control-empty compact"><span>На ближайшие семь дней событий нет.</span></div>
      </article>
    </template>
  </section>
</template>
