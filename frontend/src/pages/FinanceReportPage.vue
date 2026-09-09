<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { call } from "../api";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartDataTable from "../components/SmartDataTable.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";

const route = useRoute(), loading = ref(true), error = ref(""), data = reactive({}), options = reactive({ entities: [], points: [], groups: [] });
const filters = ref({ month: new Date().toISOString().slice(0, 7), from_date: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10), to_date: new Date().toISOString().slice(0, 10), business_entity: "", business_point: "", catalog_group: "", search: "" });
const kind = computed(() => route.meta.kind || "report");
const money = (value) => `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0))} ₽`;
const percent = (value) => `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(Number(value || 0))}%`;
const points = computed(() => options.points.filter((item) => !filters.value.business_entity || item.business_entity === filters.value.business_entity));
const heading = computed(() => ({ overview: "Финансовый обзор", report: "Финансовый отчёт", settlements: "Задолженность поставщикам", profitability: "Прибыльность" }[kind.value]));
const filterFields = computed(() => [
  ...(kind.value === "report" || kind.value === "overview"
    ? [{ key: "month", label: "Месяц", type: "month" }]
    : kind.value === "settlements"
      ? [{ key: "search", label: "Поиск", placeholder: "Поставщик", wide: true }]
      : [{ key: "search", label: "Поиск", placeholder: "Товар или код", wide: true }, { key: "from_date", label: "Период с", type: "date" }, { key: "to_date", label: "Период по", type: "date" }]),
  { key: "business_entity", label: "Юридическое лицо", type: "select", allLabel: "Все ИП", options: options.entities.map((item) => ({ value: item.name, label: item.short_name })) },
  { key: "business_point", label: "Точка", type: "select", allLabel: "Все точки", options: points.value.map((item) => ({ value: item.name, label: item.point_name })) },
  ...(kind.value === "profitability" ? [{ key: "catalog_group", label: "Группа", type: "select", allLabel: "Все группы", options: options.groups.map((item) => ({ value: item.name, label: item.group_name })) }] : []),
]);
const columns = computed(() => kind.value === "settlements" ? [
  { key: "supplier_name", label: "Поставщик", primary: true, width: 260 },
  { key: "orders_count", label: "Заказов", number: true },
  { key: "order_total", label: "Сумма заказов", number: true, format: money },
  { key: "paid_amount", label: "Оплачено", number: true, format: money },
  { key: "outstanding_amount", label: "Задолженность", number: true, format: money },
  { key: "overdue_amount", label: "Просрочено", number: true, format: money },
  { key: "nearest_due_date", label: "Ближайший срок", format: value => value ? new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T00:00:00`)) : "—" },
] : [
  { key: "item_name", label: "Наименование", primary: true, width: 260 },
  { key: "documents", label: "Документы", number: true },
  { key: "quantity", label: "Количество", number: true },
  { key: "revenue", label: "Выручка", number: true, format: money },
  { key: "cost", label: "Себестоимость", number: true, format: money },
  { key: "returns", label: "Возвраты", number: true, format: money },
  { key: "discounts", label: "Скидки", number: true, format: money },
  { key: "margin", label: "Рентабельность", number: true, format: percent },
  { key: "profit", label: "Прибыль", number: true, format: money },
]);

async function load() {
  loading.value = true; error.value = "";
  try {
    let method = "get_financial_report", params = { month: `${filters.value.month}-01`, business_entity: filters.value.business_entity, business_point: filters.value.business_point };
    if (kind.value === "settlements") { Object.assign(data, await call("raspechatka.api.supplier_settlements.get_supplier_debt", { business_entity: filters.value.business_entity, business_point: filters.value.business_point, search: filters.value.search })); return; }
    if (kind.value === "profitability") { method = "get_profitability"; params = { from_date: filters.value.from_date, to_date: filters.value.to_date, business_entity: filters.value.business_entity, business_point: filters.value.business_point, catalog_group: filters.value.catalog_group, search: filters.value.search }; }
    Object.assign(data, await call(`raspechatka.api.finance.${method}`, params));
  } catch (exception) { error.value = exception.message; }
  finally { loading.value = false; }
}
async function init() { Object.assign(options, await call("raspechatka.api.finance.get_finance_options")); options.groups = await call("raspechatka.api.frontend.get_catalog_filters").then((result) => result.groups); await load(); }
watch(kind, load); onMounted(init);
</script>

<template>
  <section class="page finance-page">
    <ListPageHeader :title="heading" />
    <SmartFilterBar :key="kind" v-model="filters" :fields="filterFields" :view-key="`finance.${kind}`" @apply="load" @reset="load" />
    <div v-if="loading&&(kind==='report'||kind==='overview')" class="table-message"><span class="loader"></span><span>Рассчитываем показатели…</span></div>
    <div v-else-if="error&&(kind==='report'||kind==='overview')" class="table-message error-message"><strong>Не удалось сформировать отчёт</strong><span>{{error}}</span><button @click="load">Повторить</button></div>
    <template v-else-if="kind==='report'||kind==='overview'">
      <div class="finance-kpis"><article class="accent"><small>ВЫРУЧКА</small><b>{{money(data.pnl?.revenue)}}</b><span>план {{money(data.plan_fact?.revenue_plan)}} · {{percent(data.plan_fact?.revenue_attainment)}}</span></article><article><small>РАСХОДЫ</small><b>{{money(data.pnl?.expenses)}}</b><span>по проведённым платежам</span></article><article><small>ЧИСТАЯ ПРИБЫЛЬ</small><b>{{money(data.pnl?.net_profit)}}</b><span>рентабельность {{percent(data.pnl?.margin)}}</span></article><article><small>ДЕНЬГИ НА КОНЕЦ</small><b>{{money(data.cash_flow?.closing_cash)}}</b><span>чистый поток {{money(data.cash_flow?.net_cash_flow)}}</span></article></div>
      <div class="finance-report-grid"><article class="finance-panel"><header><small>ОПиУ</small><h2>Доходы и расходы</h2></header><div class="statement-row"><span>Выручка</span><b>{{money(data.pnl?.revenue)}}</b></div><div class="statement-row"><span>Расходы</span><b>−{{money(data.pnl?.expenses)}}</b></div><div class="statement-row total"><span>Чистая прибыль</span><b>{{money(data.pnl?.net_profit)}}</b></div><div v-for="row in data.articles" :key="row.article" class="statement-row detail"><span>{{row.article_name}}</span><span>{{money(row.actual)}}</span></div></article><article class="finance-panel"><header><small>ДДС</small><h2>Движение денег</h2></header><div class="statement-row"><span>Деньги на начало</span><b>{{money(data.cash_flow?.opening_cash)}}</b></div><div v-for="(row,key) in data.cash_flow?.sections" :key="key" class="statement-row"><span>{{key==='Operating'?'Операционная деятельность':key==='Investing'?'Инвестиции':'Финансирование'}}</span><b>{{money(row.net)}}</b></div><div class="statement-row total"><span>Деньги на конец</span><b>{{money(data.cash_flow?.closing_cash)}}</b></div></article><article class="finance-panel"><header><small>БАЛАНС</small><h2>Финансовая позиция</h2></header><div class="statement-row"><span>Деньги</span><b>{{money(data.balance?.cash)}}</b></div><div class="statement-row"><span>Запасы</span><b>{{money(data.balance?.inventory)}}</b></div><div class="statement-row"><span>Оборудование</span><b>{{money(data.balance?.equipment)}}</b></div><div class="statement-row"><span>Обязательства</span><b>−{{money(data.balance?.liabilities)}}</b></div><div class="statement-row total"><span>Чистая позиция</span><b>{{money(data.balance?.net_position)}}</b></div></article></div>
    </template>
    <template v-else>
      <div v-if="kind==='profitability'&&!data.source_ready" class="integration-note"><b>Отчёт готов к данным кассы</b><span>Строки появятся после подключения продаж: выручка − возвраты − скидки − себестоимость.</span></div>
      <SmartDataTable :rows="data.rows||[]" :columns="columns" :row-key="kind==='settlements'?'supplier':'item'" :totals="kind==='settlements'?data.totals:undefined" :view-key="`finance.${kind}`" :loading="loading" :error="error" :selectable="false" empty-text="Измените период или добавьте связанные операции." @retry="load" />
    </template>
  </section>
</template>
