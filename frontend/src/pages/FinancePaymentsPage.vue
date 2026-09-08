<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { call, canAccess } from "../api";
import AppModal from "../components/AppModal.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";
import SmartDataTable from "../components/SmartDataTable.vue";

const rows = ref([]);
const loading = ref(true);
const error = ref("");
const editorOpen = ref(false);
const cashExpenseOpen = ref(false);
const saving = ref(false);
const formError = ref("");
const options = reactive({ entities: [], points: [], accounts: [], articles: [], payment_methods: [], cash_registers: [] });
const filters = reactive({
	from_date: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
	to_date: new Date().toISOString().slice(0, 10),
	business_entity: "",
	business_point: "",
	direction: "",
	financial_article: "",
	status: "",
	search: "",
});
const form = reactive({});
const totals = reactive({ income: 0, expense: 0, net: 0 });
const canCreateCashExpense = computed(() => canAccess("finance.cash_expense", "Edit"));
const pointsFor = (entity) => options.points.filter((row) => !entity || row.business_entity === entity);
const expenseArticles = computed(() => options.articles.filter((row) => row.article_type === "Expense"));
const money = (value) => `${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0))} ₽`;
const date = (value) => value ? new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T00:00:00`)) : "—";
const directionLabel = (value) => value === "Income" ? "Приход" : value === "Expense" ? "Расход" : "Перемещение";
const sourceLabel = (value) => ({ "Tochka Bank": "Точка Банк", Cash: "Наличные", POS: "Касса", Warehouse: "Склад", Payroll: "Зарплата", Manual: "Ранее вручную" }[value] || value || "—");
const statusLabel = (row) => {
	if (row.docstatus === 2) return "Отменён";
	if (row.processing_status === "Auto Posted") return "Учтён автоматически";
	if (row.processing_status === "Manual Posted") return "Учтён вручную";
	if (row.processing_status === "Excluded") return "Исключён";
	if (row.processing_status === "Error") return "Ошибка";
	return row.docstatus === 1 ? "Проведён" : "Черновик";
};
const filterFields = computed(() => [
	{ key: "search", label: "Поиск", placeholder: "Номер, контрагент или назначение", wide: true },
	{ key: "from_date", label: "Период с", type: "date" },
	{ key: "to_date", label: "Период по", type: "date" },
	{ key: "business_entity", label: "Юридическое лицо", type: "select", allLabel: "Все ИП", options: options.entities.map((item) => ({ value: item.name, label: item.short_name })) },
	{ key: "business_point", label: "Точка", type: "select", allLabel: "Все точки", options: pointsFor(filters.business_entity).map((item) => ({ value: item.name, label: item.point_name })) },
	{ key: "direction", label: "Операция", type: "select", allLabel: "Все операции", options: [{ value: "Income", label: "Приход" }, { value: "Expense", label: "Расход" }, { value: "Transfer", label: "Перемещение" }] },
	{ key: "financial_article", label: "Статья", type: "select", allLabel: "Все статьи", options: options.articles.map((item) => ({ value: item.name, label: item.article_name })) },
	{ key: "status", label: "Статус", type: "select", allLabel: "Все статусы", options: [{ value: "Posted", label: "Проведённые" }, { value: "Cancelled", label: "Отменённые" }] },
]);
const listColumns = [
	{ key: "name", label: "№", primary: true, width: 140 },
	{ key: "posting_date", label: "Дата", format: date, width: 120 },
	{ key: "direction", label: "Операция", format: directionLabel, width: 120 },
	{ key: "counterparty_name", label: "Контрагент", width: 190 },
	{ key: "purpose", label: "Назначение", width: 280 },
	{ key: "financial_article", label: "Статья", width: 180 },
	{ key: "business_point", label: "Точка", width: 170 },
	{ key: "source", label: "Источник", format: sourceLabel, width: 130 },
	{ key: "amount", label: "Сумма", format: money, number: true, width: 140 },
	{ key: "processing_status", label: "Статус", width: 170 },
];

async function load() {
	loading.value = true;
	error.value = "";
	try {
		const result = await call("raspechatka.api.finance.get_payments", filters);
		rows.value = result.rows;
		Object.assign(totals, result.totals);
	} catch (exception) {
		error.value = exception.message;
	} finally {
		loading.value = false;
	}
}
async function loadOptions() {
	try {
		Object.assign(options, await call("raspechatka.api.finance.get_finance_options"));
	} catch (exception) {
		error.value = exception.message;
	}
}
async function openPayment(name) {
	formError.value = "";
	try {
		const doc = await call("raspechatka.api.finance.get_payment", { name });
		Object.keys(form).forEach((key) => delete form[key]);
		Object.assign(form, doc);
		editorOpen.value = true;
	} catch (exception) {
		error.value = exception.message;
	}
}
async function openCashExpense() {
	formError.value = "";
	try {
		const draft = await call("raspechatka.api.finance.get_cash_expense");
		Object.keys(form).forEach((key) => delete form[key]);
		Object.assign(form, draft, {
			business_entity: options.entities[0]?.name || "",
			business_point: "",
			financial_article: "",
		});
		cashExpenseOpen.value = true;
	} catch (exception) {
		error.value = exception.message;
	}
}
function onEntity() {
	if (!pointsFor(form.business_entity).some((item) => item.name === form.business_point)) form.business_point = "";
}
async function saveCashExpense() {
	saving.value = true;
	formError.value = "";
	try {
		await call("raspechatka.api.finance.create_cash_expense", { data: JSON.stringify(form) }, { method: "POST" });
		cashExpenseOpen.value = false;
		await load();
	} catch (exception) {
		formError.value = exception.message;
	} finally {
		saving.value = false;
	}
}
async function cancelPayment() {
	if (!confirm("Отменить платёж и связанную кассовую операцию?")) return;
	try {
		await call("raspechatka.api.finance.cancel_payment", { name: form.name }, { method: "POST" });
		editorOpen.value = false;
		await load();
	} catch (exception) {
		formError.value = exception.message;
	}
}

onMounted(() => Promise.all([loadOptions(), load()]));
</script>

<template>
	<section class="page finance-page">
		<ListPageHeader title="Платежи">
			<template #actions>
				<button v-if="canCreateCashExpense" class="button button-primary" @click="openCashExpense">＋ Наличный расход</button>
			</template>
		</ListPageHeader>
		<div class="finance-summary">
			<article><span>ПРИХОД</span><b>{{ money(totals.income) }}</b></article>
			<article><span>РАСХОД</span><b>{{ money(totals.expense) }}</b></article>
			<article :class="{ accent: totals.net >= 0 }"><span>ДЕНЕЖНЫЙ ПОТОК</span><b>{{ money(totals.net) }}</b></article>
		</div>
		<SmartFilterBar :model-value="filters" :fields="filterFields" view-key="finance.payments" @update:model-value="Object.assign(filters, $event)" @apply="load" @reset="load" />
		<SmartDataTable
			:rows="rows"
			:columns="listColumns"
			:totals="{ amount: totals.net }"
			view-key="finance.payments"
			:loading="loading"
			:error="error"
			empty-title="Платежей пока нет"
			empty-text="Банковские операции появятся автоматически после обработки выписки."
			@open="openPayment($event.name)"
			@retry="load"
		>
			<template #cell-direction="{ row }"><span class="type-chip" :class="{ income: row.direction === 'Income' }">{{ directionLabel(row.direction) }}</span></template>
			<template #cell-amount="{ row }"><span :class="{ positive: row.direction === 'Income' }">{{ row.direction === "Expense" ? "−" : "+" }}{{ money(row.amount) }}</span></template>
			<template #cell-processing_status="{ row }"><span class="document-state" :class="`state-${row.docstatus}`">{{ statusLabel(row) }}</span></template>
		</SmartDataTable>

		<AppModal v-if="cashExpenseOpen" title="Наличный расход" @close="cashExpenseOpen = false">
			<form class="editor-form" @submit.prevent="saveCashExpense">
				<div class="form-section">
					<h3>Расход из кассы точки</h3>
					<div class="form-grid">
						<label>ИП<select v-model="form.business_entity" required @change="onEntity"><option value="">Не выбрано</option><option v-for="item in options.entities" :key="item.name" :value="item.name">{{ item.short_name }}</option></select></label>
						<label>Точка<select v-model="form.business_point" required><option value="">Не выбрана</option><option v-for="item in pointsFor(form.business_entity)" :key="item.name" :value="item.name">{{ item.point_name }}</option></select></label>
						<label>Сумма<input v-model.number="form.amount" type="number" min="0.01" step="0.01" required /></label>
						<label>Статья<select v-model="form.financial_article" required><option value="">Не выбрана</option><option v-for="item in expenseArticles" :key="item.name" :value="item.name">{{ item.article_name }}</option></select></label>
						<label class="span-2">Контрагент<input v-model="form.counterparty_name" placeholder="При необходимости" /></label>
						<label class="span-2">Назначение<textarea v-model="form.purpose" rows="2" required /></label>
						<label class="span-2">Комментарий<textarea v-model="form.comment" rows="2" /></label>
					</div>
				</div>
				<p v-if="formError" class="form-error">{{ formError }}</p>
			</form>
			<template #footer><span></span><div class="footer-actions"><button class="button button-secondary" @click="cashExpenseOpen = false">Отмена</button><button class="button button-primary" :disabled="saving" @click="saveCashExpense">Провести расход</button></div></template>
		</AppModal>

		<AppModal v-if="editorOpen" :title="`Платёж ${form.name}`" wide @close="editorOpen = false">
			<div class="form-section">
				<h3>{{ statusLabel(form) }}</h3>
				<div class="form-grid">
					<label>Операция<input :value="directionLabel(form.direction)" disabled /></label>
					<label>Дата<input :value="date(form.posting_date)" disabled /></label>
					<label>Сумма<input :value="money(form.amount)" disabled /></label>
					<label>Источник<input :value="sourceLabel(form.source)" disabled /></label>
					<label>ИП<input :value="form.business_entity || '—'" disabled /></label>
					<label>Точка<input :value="form.business_point || '—'" disabled /></label>
					<label>Статья<input :value="form.financial_article || '—'" disabled /></label>
					<label>Контрагент<input :value="form.counterparty_name || '—'" disabled /></label>
					<label class="span-3">Назначение<textarea :value="form.purpose" rows="2" disabled /></label>
					<label class="span-3">Комментарий<textarea :value="form.comment" rows="2" disabled /></label>
				</div>
			</div>
			<p v-if="formError" class="form-error">{{ formError }}</p>
			<template #footer>
				<button v-if="form.docstatus === 1 && form.source === 'Cash' && canCreateCashExpense" class="button button-secondary danger" @click="cancelPayment">Отменить</button>
				<button class="button button-secondary" @click="editorOpen = false">Закрыть</button>
			</template>
		</AppModal>
	</section>
</template>
