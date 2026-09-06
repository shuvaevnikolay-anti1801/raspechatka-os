<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { call, canAccess } from "../api";
import AppModal from "../components/AppModal.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";
import SmartDataTable from "../components/SmartDataTable.vue";

const data = reactive({ connections: [], operations: [], rules: [], review_count: 0 });
const options = reactive({ entities: [], points: [], articles: [] });
const loading = ref(true), error = ref(""), connectionOpen = ref(false), reviewOpen = ref(false), saving = ref(false);
const filters = ref({ search: "", direction: "", status: "" });
const connectionForm = reactive({}), reviewForm = reactive({});
const canEdit = computed(() => canAccess("finance.bank", "Edit"));
const money = (value) => `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2 }).format(Number(value || 0))} ₽`;
const dt = (value) => value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(String(value).replace(" ", "T"))) : "—";
const filterFields = [
  { key: "search", label: "Поиск", placeholder: "Контрагент или назначение", wide: true },
  { key: "direction", label: "Операция", type: "select", options: [{ value: "Income", label: "Приход" }, { value: "Expense", label: "Расход" }] },
  { key: "status", label: "Статус", type: "select", options: [{ value: "New", label: "Новая" }, { value: "Review", label: "На проверке" }, { value: "Classified", label: "Классифицирована" }] },
];
const operations = computed(() => data.operations.filter((row) =>
  (!filters.value.search || `${row.counterparty_name || ""} ${row.purpose || ""}`.toLowerCase().includes(filters.value.search.toLowerCase())) &&
  (!filters.value.direction || row.direction === filters.value.direction) &&
  (!filters.value.status || row.processing_status === filters.value.status)));
const columns = [
  { key: "posted_at", label: "Дата", width: 150, format: dt },
  { key: "counterparty_name", label: "Контрагент", primary: true, width: 220 },
  { key: "purpose", label: "Назначение", width: 320 },
  { key: "direction", label: "Операция", width: 120, format: (value) => value === "Income" ? "Приход" : "Расход" },
  { key: "amount", label: "Сумма", number: true, width: 140, format: money },
  { key: "processing_status", label: "Статус", width: 150 },
];

async function load() { loading.value = true; try { Object.assign(data, await call("raspechatka.api.tochka.get_bank_workspace")); } catch (exception) { error.value = exception.message; } finally { loading.value = false; } }
async function init() { Object.assign(options, await call("raspechatka.api.finance.get_finance_options")); await load(); }
function openConnection() { Object.assign(connectionForm, { connection_name: "Точка Банк", business_entity: options.entities[0]?.name || "", bank_name: "Точка", enabled: 0, sync_mode: "Dry Run", sync_interval_minutes: 15, overlap_days: 2, client_id: "", client_secret: "" }); connectionOpen.value = true; }
async function saveConnection() { saving.value = true; try { await call("raspechatka.api.tochka.save_connection", { data: JSON.stringify(connectionForm) }, { method: "POST" }); connectionOpen.value = false; await load(); } catch (exception) { error.value = exception.message; } finally { saving.value = false; } }
async function connect(row) { try { const result = await call("raspechatka.api.tochka.begin_oauth", { connection: row.name }, { method: "POST" }); window.open(result.url, "_blank", "noopener"); await load(); } catch (exception) { error.value = exception.message; } }
async function accounts(row) { try { const result = await call("raspechatka.api.tochka.refresh_accounts", { connection: row.name }, { method: "POST" }); alert(`Получено счетов: ${result.received}, сопоставлено: ${result.matched}`); } catch (exception) { error.value = exception.message; } }
async function sync(row) { try { await call("raspechatka.api.tochka.sync_now", { connection: row.name }, { method: "POST" }); alert("Синхронизация поставлена в очередь"); } catch (exception) { error.value = exception.message; } }
function review(row) { if (row.processing_status !== "Review") return; Object.keys(reviewForm).forEach((key) => delete reviewForm[key]); Object.assign(reviewForm, row, { financial_article: "", business_point: "", result: "Approve" }); reviewOpen.value = true; }
async function classify() { saving.value = true; try { await call("raspechatka.api.tochka.classify_operation", { name: reviewForm.name, financial_article: reviewForm.financial_article, business_point: reviewForm.business_point, result: reviewForm.result }, { method: "POST" }); reviewOpen.value = false; await load(); } catch (exception) { error.value = exception.message; } finally { saving.value = false; } }
onMounted(init);
</script>

<template>
  <section class="page finance-page">
    <ListPageHeader title="Точка Банк"><template #actions><button v-if="canEdit" class="button button-primary" @click="openConnection">＋ Подключение</button></template></ListPageHeader>
    <div class="bank-security-note"><span>●</span><div><b>Банк — первичный источник фактов</b><p>Исходные операции сохраняются без изменений. Секреты OAuth хранятся в зашифрованных полях Frappe и не попадают в код.</p></div></div>
    <div class="bank-connections"><article v-for="row in data.connections" :key="row.name"><div><small>{{row.bank_name}}</small><h3>{{row.connection_name}}</h3><span>{{row.business_entity}}</span></div><span class="connection-status" :class="row.status.toLowerCase().replace(' ','-')">{{row.status}}</span><div class="connection-actions"><button class="button button-secondary" @click="connect(row)">Подключить OAuth</button><button class="button button-secondary" :disabled="row.status!=='Connected'" @click="accounts(row)">Получить счета</button><button class="button button-primary" :disabled="row.status!=='Connected'" @click="sync(row)">Синхронизировать</button></div></article><div v-if="!data.connections.length" class="empty-connection"><b>Банк ещё не подключён</b><span>Создайте подключение для каждого ИП. Начните с режима Dry Run.</span></div></div>
    <div class="section-heading bank-heading"><div><h2>Очередь обработки</h2></div><span class="review-count">{{data.review_count}} требуют проверки</span></div>
    <SmartFilterBar v-model="filters" :fields="filterFields" view-key="finance.bank.operations" />
    <SmartDataTable :rows="operations" :columns="columns" view-key="finance.bank.operations" :loading="loading" :error="error" empty-title="Операций пока нет" empty-text="После подключения и синхронизации здесь появится выписка." @open="review" @retry="load"><template #cell-processing_status="{row}"><span class="document-state" :class="`bank-${row.processing_status.toLowerCase()}`">{{row.processing_status}}</span></template></SmartDataTable>
    <AppModal v-if="connectionOpen" title="Подключение Точка Банка" @close="connectionOpen=false"><form class="editor-form"><div class="form-section"><div class="form-grid"><label class="span-2">Название<input v-model="connectionForm.connection_name" required/></label><label>ИП<select v-model="connectionForm.business_entity" required><option v-for="item in options.entities" :key="item.name" :value="item.name">{{item.short_name}}</option></select></label><label>Режим<select v-model="connectionForm.sync_mode"><option value="Dry Run">Dry Run — проверка</option><option value="Live">Live — работа</option></select></label><label>Client ID<input v-model="connectionForm.client_id" type="password" autocomplete="off"/></label><label>Client secret<input v-model="connectionForm.client_secret" type="password" autocomplete="off"/></label><label><input v-model="connectionForm.enabled" type="checkbox" :true-value="1" :false-value="0"/> Автосинхронизация</label></div></div></form><template #footer><span></span><div class="footer-actions"><button class="button button-secondary" @click="connectionOpen=false">Закрыть</button><button class="button button-primary" :disabled="saving" @click="saveConnection">Сохранить</button></div></template></AppModal>
    <AppModal v-if="reviewOpen" title="Классификация операции" @close="reviewOpen=false"><div class="review-operation"><b>{{reviewForm.counterparty_name}}</b><strong>{{money(reviewForm.amount)}}</strong><p>{{reviewForm.purpose}}</p></div><div class="form-grid"><label class="span-2">Финансовая статья<select v-model="reviewForm.financial_article"><option value="">Не выбрана</option><option v-for="item in options.articles.filter(article=>article.article_type===(reviewForm.direction==='Income'?'Income':'Expense'))" :key="item.name" :value="item.name">{{item.article_name}}</option></select></label><label>Точка<select v-model="reviewForm.business_point"><option value="">Без точки</option><option v-for="item in options.points" :key="item.name" :value="item.name">{{item.point_name}}</option></select></label><label>Решение<select v-model="reviewForm.result"><option value="Approve">Провести</option><option value="Ignore">Не учитывать</option></select></label></div><template #footer><span></span><button class="button button-primary" :disabled="saving" @click="classify">Применить</button></template></AppModal>
  </section>
</template>
