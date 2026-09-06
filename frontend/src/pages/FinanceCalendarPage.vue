<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { call, canAccess } from "../api";
import AppModal from "../components/AppModal.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartDataTable from "../components/SmartDataTable.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";

const rows = ref([]), loading = ref(true), error = ref(""), open = ref(false), saving = ref(false);
const totals = reactive({ planned: 0, paid: 0, remaining: 0 });
const options = reactive({ entities: [], points: [], accounts: [], articles: [] });
const filters = ref({ month: new Date().toISOString().slice(0, 7), business_entity: "", business_point: "" });
const form = reactive({});
const canEdit = computed(() => canAccess("finance.planning", "Edit"));
const money = (value) => `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0))} ₽`;
const date = (value) => new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" }).format(new Date(`${value}T00:00:00`));
const pointsFor = (entity) => options.points.filter((item) => !entity || item.business_entity === entity);
const articlesFor = (direction) => options.articles.filter((item) => item.article_type === (direction === "Income" ? "Income" : "Expense"));
const filterFields = computed(() => [
  { key: "month", label: "Месяц", type: "month" },
  { key: "business_entity", label: "Юридическое лицо", type: "select", allLabel: "Все ИП", options: options.entities.map((item) => ({ value: item.name, label: item.short_name })) },
  { key: "business_point", label: "Точка", type: "select", allLabel: "Все точки", options: pointsFor(filters.value.business_entity).map((item) => ({ value: item.name, label: item.point_name })) },
]);
const columns = [
  { key: "planned_date", label: "Дата", width: 120, format: date },
  { key: "title", label: "Платёж", primary: true, width: 250 },
  { key: "counterparty_name", label: "Контрагент", width: 200 },
  { key: "financial_article", label: "Статья", width: 180 },
  { key: "business_point", label: "Точка", width: 180 },
  { key: "direction", label: "Тип", width: 120, format: (value) => value === "Income" ? "Поступление" : "Оплата" },
  { key: "amount", label: "Сумма", number: true, width: 140, format: money },
  { key: "display_status", label: "Статус", width: 140 },
];
const tableTotals = computed(() => ({ amount: totals.planned }));

async function load() {
  loading.value = true; error.value = "";
  try {
    const result = await call("raspechatka.api.finance.get_payment_calendar", { month: `${filters.value.month}-01`, business_entity: filters.value.business_entity, business_point: filters.value.business_point });
    rows.value = result.rows || []; Object.assign(totals, result.totals || {});
  } catch (exception) { error.value = exception.message; }
  finally { loading.value = false; }
}
async function init() { Object.assign(options, await call("raspechatka.api.finance.get_finance_options")); await load(); }
function edit(row = null) {
  Object.keys(form).forEach((key) => delete form[key]);
  Object.assign(form, row ? JSON.parse(JSON.stringify(row)) : { title: "", planned_date: `${filters.value.month}-01`, direction: "Expense", amount: 0, currency: "RUB", status: "Planned", business_entity: filters.value.business_entity || options.entities[0]?.name || "", business_point: filters.value.business_point || "", recurrence: "Once" });
  open.value = true;
}
async function save() { saving.value = true; try { await call("raspechatka.api.finance.save_plan_item", { data: JSON.stringify(form) }, { method: "POST" }); open.value = false; await load(); } catch (exception) { error.value = exception.message; } finally { saving.value = false; } }
async function remove() { if (!confirm("Удалить плановый платёж?")) return; await call("raspechatka.api.finance.delete_plan_item", { name: form.name }, { method: "POST" }); open.value = false; await load(); }
onMounted(init);
</script>

<template>
  <section class="page finance-page">
    <ListPageHeader title="Платёжный календарь"><template #actions><button v-if="canEdit" class="button button-primary" @click="edit()">＋ Запланировать</button></template></ListPageHeader>
    <div class="finance-summary"><article><span>ВСЕГО К ОПЛАТЕ</span><b>{{money(totals.planned)}}</b></article><article class="accent"><span>ОПЛАЧЕНО</span><b>{{money(totals.paid)}}</b></article><article><span>ОСТАЛОСЬ</span><b>{{money(totals.remaining)}}</b></article></div>
    <SmartFilterBar v-model="filters" :fields="filterFields" view-key="finance.calendar" @apply="load" @reset="load" />
    <SmartDataTable :rows="rows" :columns="columns" :totals="tableTotals" view-key="finance.calendar" :loading="loading" :error="error" empty-title="На этот месяц ничего не запланировано" empty-text="Добавьте регулярные и разовые платежи." @open="edit" @retry="load">
      <template #cell-display_status="{row}"><span class="document-state" :class="`plan-${row.display_status.toLowerCase()}`">{{row.display_status==='Overdue'?'Просрочено':row.display_status==='Paid'?'Оплачено':row.display_status==='Cancelled'?'Отменено':'Запланировано'}}</span></template>
    </SmartDataTable>
    <AppModal v-if="open" :title="form.name?'Плановый платёж':'Новый плановый платёж'" @close="open=false"><form class="editor-form" @submit.prevent="save"><div class="form-section"><div class="form-grid"><label class="span-2">Название<input v-model="form.title" required/></label><label>Дата<input v-model="form.planned_date" type="date" required/></label><label>Тип<select v-model="form.direction"><option value="Expense">Расход</option><option value="Income">Приход</option></select></label><label>Сумма<input v-model.number="form.amount" type="number" min="0.01" step="0.01" required/></label><label>Статус<select v-model="form.status"><option value="Planned">Запланировано</option><option value="Paid">Оплачено</option><option value="Cancelled">Отменено</option></select></label><label>ИП<select v-model="form.business_entity" required><option v-for="item in options.entities" :key="item.name" :value="item.name">{{item.short_name}}</option></select></label><label>Точка<select v-model="form.business_point"><option value="">В целом по ИП</option><option v-for="item in pointsFor(form.business_entity)" :key="item.name" :value="item.name">{{item.point_name}}</option></select></label><label>Статья<select v-model="form.financial_article" required><option v-for="item in articlesFor(form.direction)" :key="item.name" :value="item.name">{{item.article_name}}</option></select></label><label>Контрагент<input v-model="form.counterparty_name"/></label><label>Повторение<select v-model="form.recurrence"><option value="Once">Один раз</option><option value="Monthly">Каждый месяц</option></select></label><label class="span-3">Комментарий<textarea v-model="form.comment"></textarea></label></div></div></form><template #footer><div><button v-if="form.name&&canEdit&&form.status!=='Paid'" class="button button-secondary danger" @click="remove">Удалить</button></div><div class="footer-actions"><button class="button button-secondary" @click="open=false">Закрыть</button><button v-if="canEdit" class="button button-primary" :disabled="saving" @click="save">Сохранить</button></div></template></AppModal>
  </section>
</template>
