<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { call, canAccess } from "../api";
import AppModal from "../components/AppModal.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";
import SmartDataTable from "../components/SmartDataTable.vue";
import { mergeEntityFields } from "../entityListSchema";
import { createLatestRequestGate } from "../listLoading";
import { dateInTimezone, formatDateTime, monthStartInTimezone } from "../dateTime";
const listRequests = createLatestRequestGate();
const route = useRoute(),
	kind = computed(() => route.meta.kind || "overview"),
	rows = ref([]),
	totals = ref({}),
	loading = ref(true),
	error = ref(""),
	selectedDoc = ref(null),
	token = ref(null),
	settingsSaving = ref(false),
	settingsMessage = ref("");
const posSettings = reactive({
	allow_free_price: 0,
	allow_discounts: 1,
	max_discount_percent: 100,
	review_discount_per_review: 0,
	allow_remove_cart_item: 1,
	accepts_cash: 1,
	accepts_card: 1,
	accepts_qr: 1,
	markup_lower_threshold: 100,
	markup_upper_threshold: 200,
});
const canEditIntegration = computed(() => canAccess("page.sales.integration", "Edit"));
const upsellConfig = reactive({ rules: [], catalog_items: [] });
const upsellSaving = ref(false);
const upsellMessage = ref("");
const options = reactive({ entities: [], points: [], cashiers: [] });
const today = new Date().toISOString().slice(0, 10),
	month = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
		.toISOString()
		.slice(0, 10);
const filters = reactive({
	from_date: month,
	to_date: today,
	business_entity: "",
	business_point: "",
	cashier: "",
	search: "",
	status: "",
	overdue: "",
	due_from: "",
	due_to: "",
	ready_from: "",
	ready_to: "",
	movement_type: "",
	action_type: "",
});
const cfg = {
	overview: { title: "Точки продаж", desc: "Текущая работа касс и продажи по всей сети" },
	shifts: { title: "Смены", desc: "Выручка, возвраты, скидки и действия за каждую смену" },
	receipts: { title: "Продажи", desc: "Все чеки, оплаты, товары и клиенты" },
	orders: { title: "Заказы", desc: "Оплаченные заказы, сроки готовности и история исполнения" },
	returns: { title: "Возвраты", desc: "Возвратные чеки и связь с исходной продажей" },
	cash: {
		title: "Внесения и выплаты",
		desc: "Движение наличных между кассой ИП и кассой точки",
	},
	actions: {
		title: "Действия кассира",
		desc: "Неизменяемый журнал операций и контрольных событий",
	},
	integration: {
		title: "Подключение кассы",
		desc: "Безопасный обмен с Windows-программой каждой точки",
	},
};
const pointMap = computed(() =>
		Object.fromEntries(options.points.map((x) => [x.name, x.point_name]))
	),
	employeeMap = computed(() =>
		Object.fromEntries(options.cashiers.map((x) => [x.name, x.full_name]))
	),
	points = computed(() =>
		options.points.filter(
			(x) => !filters.business_entity || x.business_entity === filters.business_entity
		)
	);
const money = (v) =>
	`${new Intl.NumberFormat("ru-RU", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(Number(v || 0))} ₽`;
const date = (value) => formatDateTime(value);
const actionLabel = (v) =>
	({
		OPEN_SHIFT: "Открытие смены",
		CLOSE_SHIFT: "Закрытие смены",
		CASH_COUNT: "Пересчёт наличных",
		SALE: "Продажа",
		RETURN: "Возврат",
		DEPOSIT: "Внесение",
		WITHDRAWAL: "Выплата",
		CANCEL_RECEIPT: "Отмена чека",
		CANCEL_CASH_MOVEMENT: "Отмена кассовой операции",
		REMOVE_ITEM: "Удаление позиции",
		PRICE_OVERRIDE: "Свободная цена",
		DISCOUNT: "Скидка",
		REVIEW_RECEIVED: "Получен отзыв",
		CLUB_REGISTRATION: "Регистрация в клубе",
		GIFT_ORDER: "Заказ подарка",
	}[v] || v);
const columns = computed(
	() =>
		({
			shifts: [
				c("name", "Смена"),
				c("shift_type", "Тип"),
				c("opened_at", "Открыта", "date"),
				c("closed_at", "Закрыта", "date"),
				c("business_point", "Точка", "point"),
				c("cashier", "Кассир", "employee"),
				c("receipt_count", "Чеки"),
				c("gross_sales", "Продажи после скидок", "money"),
				c("returns_total", "Возвраты", "money"),
				c("net_sales", "Чистая выручка", "money"),
				c("average_check", "Средний чек", "money"),
				c("discounts_total", "Скидки", "money"),
				c("discounted_receipt_count", "Чеков со скидкой"),
				c("discount_conversion", "Конверсия скидки", "percent"),
				c("reviews_count", "Отзывы"),
				c("club_registrations", "Клуб"),
				c("gift_orders", "Подарки"),
				c("status", "Статус"),
			],
			receipts: receiptCols(),
			returns: receiptCols(),
			orders: [
				c("short_number", "Заказ"),
				c("phone", "Телефон"),
				c("business_point", "Точка", "point"),
				c("comment", "Описание"),
				c("fiscal_number", "Чек"),
				c("total_amount", "Сумма", "money"),
				c("status", "Статус", "order_status"),
				c("created_at", "Создан", "date"),
				c("due_at", "Срок готовности", "date"),
				c("ready_at", "Готов", "date"),
				c("issued_at", "Выдан", "date"),
				c("execution_minutes", "Время выполнения", "duration"),
				c("overdue", "Просрочка", "overdue"),
			],
			cash: [
				c("name", "№"),
				c("posting_datetime", "Время", "date"),
				c("movement_type", "Операция", "movement"),
				c("business_point", "Точка", "point"),
				c("cashier", "Кассир", "employee"),
				c("from_cash", "Из кассы"),
				c("to_cash", "В кассу"),
				c("amount", "Сумма", "money"),
				c("reason", "Комментарий"),
			],
			actions: [
				c("action_datetime", "Время", "date"),
				c("action_type", "Действие", "action"),
				c("business_point", "Точка", "point"),
				c("cashier", "Кассир", "employee"),
				c("shift", "Смена"),
				c("metric_value", "Количество"),
				c("details", "Подробности"),
			],
		}[kind.value] || [])
);
function c(key, label, format = "") {
	return { key, label, format };
}
function receiptCols() {
	return [
		c("name", "Чек"),
		c("posting_datetime", "Время", "date"),
		c("business_point", "Точка", "point"),
		c("cashier", "Кассир", "employee"),
		c("client", "Клиент"),
		c("payments", "Оплата", "payment"),
		c("gross_amount", "До скидки", "money"),
		c("discount_amount", "Скидка", "money"),
		c("total_amount", "Итого", "money"),
		c("cost_amount", "Себестоимость", "money"),
		c("profit_amount", "Прибыль", "money"),
	];
}
function fmt(v, col) {
	if (col.format === "money") return money(v);
	if (col.format === "percent")
		return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(
			Number(v || 0)
		)}%`;
	if (col.format === "date") return date(v);
	if (col.format === "point") return pointMap.value[v] || v || "—";
	if (col.format === "employee") return employeeMap.value[v] || v || "—";
	if (col.format === "movement") return v === "Deposit" ? "Внесение" : "Выплата";
	if (col.format === "action") return actionLabel(v);
	if (col.format === "order_status")
		return ({ New: "В работе", "In Progress": "В работе", Ready: "Готов к выдаче", Issued: "Выдан", Cancelled: "Отменён" }[v] || v || "—");
	if (col.format === "duration") {
		if (v === null || v === undefined || v === "") return "—";
		const minutes = Math.max(0, Number(v) || 0), hours = Math.floor(minutes / 60), rest = minutes % 60;
		return hours ? `${hours} ч ${rest} мин` : `${rest} мин`;
	}
	if (col.format === "overdue") return v ? "Просрочен" : "—";
	if (col.format === "payment")
		return (
			Object.entries(v || {})
				.map(
					([k, x]) =>
						`${k === "Cash" ? "Нал." : k === "Card" ? "Карта" : "QR"} ${money(x)}`
				)
				.join(" · ") || "—"
		);
	return v ?? "—";
}
const filterFields = computed(() => {
	const result = [
		{ key: "search", label: "Поиск", placeholder: kind.value === "orders" ? "Телефон, заказ, описание или чек" : "Номер или комментарий", wide: true },
		{ key: "from_date", label: "Период с", type: "date" },
		{ key: "to_date", label: "Период по", type: "date" },
		{
			key: "business_entity",
			label: "Юридическое лицо",
			type: "select",
			allLabel: "Все ИП",
			options: options.entities.map((x) => ({ value: x.name, label: x.short_name })),
		},
		{
			key: "business_point",
			label: "Точка",
			type: "select",
			allLabel: "Все точки",
			options: points.value.map((x) => ({ value: x.name, label: x.point_name })),
		},
	];
	if (["shifts", "actions"].includes(kind.value))
		result.push({
			key: "cashier",
			label: "Кассир",
			type: "select",
			allLabel: "Все кассиры",
			options: options.cashiers.map((x) => ({ value: x.name, label: x.full_name })),
		});
	if (kind.value === "orders") {
		result.push(
			{
				key: "status", label: "Статус", type: "select", allLabel: "Все статусы",
				options: [
					{ value: "New", label: "В работе (legacy)" },
					{ value: "In Progress", label: "В работе" },
					{ value: "Ready", label: "Готов к выдаче" },
					{ value: "Issued", label: "Выдан" },
					{ value: "Cancelled", label: "Отменён" },
				],
			},
			{ key: "overdue", label: "Просрочка", type: "select", allLabel: "Все", options: [{ value: "1", label: "Только просроченные" }] },
			{ key: "due_from", label: "Срок с", type: "date" },
			{ key: "due_to", label: "Срок по", type: "date" },
			{ key: "ready_from", label: "Готов с", type: "date" },
			{ key: "ready_to", label: "Готов по", type: "date" }
		);
	} else if (["shifts", "actions"].includes(kind.value))
		result.push({
			key: "status",
			label: "Статус",
			type: "select",
			allLabel: "Все статусы",
			options: [
				{ value: "Open", label: "Открыта" },
				{ value: "Closed", label: "Закрыта" },
				{ value: "Cancelled", label: "Отменена" },
			],
		});
	if (kind.value === "cash")
		result.push({
			key: "movement_type",
			label: "Операция",
			type: "select",
			allLabel: "Все операции",
			options: [
				{ value: "Deposit", label: "Внесения" },
				{ value: "Withdrawal", label: "Выплаты" },
			],
		});
	if (kind.value === "actions")
		result.push({
			key: "action_type",
			label: "Действие",
			type: "select",
			allLabel: "Все действия",
			options: [
				"OPEN_SHIFT",
				"CLOSE_SHIFT",
				"CASH_COUNT",
				"REMOVE_ITEM",
				"PRICE_OVERRIDE",
				"DISCOUNT",
				"REVIEW_RECEIVED",
				"CLUB_REGISTRATION",
				"GIFT_ORDER",
			].map((value) => ({ value, label: actionLabel(value) })),
		});
	return result;
});
const tableColumns = computed(() =>
	columns.value.map((col) => ({
		...col,
		primary: col.key === "name" || (kind.value === "orders" && col.key === "short_number"),
		number: ["money", "percent"].includes(col.format),
		format: (value) => fmt(value, col),
	}))
);
const entityFields = computed(() => mergeEntityFields(filterFields.value, tableColumns.value));
const tableTotals = computed(() => {
	const result = {};
	for (const col of columns.value) {
		if (col.format === "money" && !["average_check"].includes(col.key))
			result[col.key] = rows.value.reduce((sum, row) => sum + Number(row[col.key] || 0), 0);
		else if (
			[
				"receipt_count",
				"reviews_count",
				"club_registrations",
				"gift_orders",
				"metric_value",
			].includes(col.key)
		)
			result[col.key] = rows.value.reduce((sum, row) => sum + Number(row[col.key] || 0), 0);
	}
	return result;
});
async function init() {
	try {
		const optionsMethod = kind.value === "orders" ? "get_order_options" : "get_sales_options";
		Object.assign(options, await call(`raspechatka.api.sales.${optionsMethod}`));
		if (kind.value === "integration") await load();
	} catch (e) {
		error.value = e.message;
		loading.value = false;
	}
}
async function load() {
	const requestId = listRequests.begin();
	loading.value = true;
	error.value = "";
	selectedDoc.value = null;
	try {
		const common = {
			from_date: filters.from_date,
			to_date: filters.to_date,
			business_entity: filters.business_entity,
			business_point: filters.business_point,
		};
		let method = "get_points_overview",
			params = common;
		if (kind.value === "shifts") {
			method = "get_shifts";
			params = {
				...common,
				cashier: filters.cashier,
				status: filters.status,
				search: filters.search,
				limit_page_length: 10000,
			};
		}
		if (kind.value === "receipts" || kind.value === "returns") {
			method = "get_receipts";
			params = {
				...common,
				cashier: filters.cashier,
				search: filters.search,
				receipt_type: kind.value === "returns" ? "Return" : "Sale",
				limit_page_length: 10000,
			};
		}
		if (kind.value === "cash") {
			method = "get_cash_movements";
			params = { ...common, movement_type: filters.movement_type, search: filters.search };
		}
		if (kind.value === "orders") {
			method = "get_orders";
			params = {
				business_entity: filters.business_entity,
				business_point: filters.business_point,
				status: filters.status,
				search: filters.search,
				overdue: filters.overdue,
				created_from: filters.from_date,
				created_to: filters.to_date,
				due_from: filters.due_from,
				due_to: filters.due_to,
				ready_from: filters.ready_from,
				ready_to: filters.ready_to,
				limit_page_length: 5000,
			};
		}
		if (kind.value === "actions") {
			method = "get_cashier_actions";
			params = { ...common, cashier: filters.cashier, action_type: filters.action_type };
		}
		if (kind.value === "integration") {
			method = "get_connections";
			params = {};
			const [salesSettings, upsellSettings] = await Promise.all([
				call("raspechatka.api.sales.get_pos_sales_settings_api"),
				call("raspechatka.api.sales.get_pos_upsell_config"),
			]);
			if (!listRequests.isCurrent(requestId)) return;
			Object.assign(posSettings, salesSettings);
			upsellConfig.catalog_items = upsellSettings.catalog_items || [];
			upsellConfig.rules = (upsellSettings.rules || []).map((rule) => ({
				...rule,
				candidates: (rule.candidates || []).map((candidate) => ({ ...candidate })),
			}));
		}
		const result = await call(`raspechatka.api.sales.${method}`, params);
		if (!listRequests.isCurrent(requestId)) return;
		rows.value = result.rows || [];
		totals.value = result.totals || {};
	} catch (e) {
		if (listRequests.isCurrent(requestId)) error.value = e.message;
	} finally {
		if (listRequests.isCurrent(requestId)) loading.value = false;
	}
}
async function savePosSettings() {
	settingsSaving.value = true;
	settingsMessage.value = "";
	try {
		Object.assign(
			posSettings,
			await call(
				"raspechatka.api.sales.save_pos_sales_settings",
				{ data: JSON.stringify(posSettings) },
				{ method: "POST" }
			)
		);
		settingsMessage.value = "Настройки сохранены";
	} catch (e) {
		settingsMessage.value = e.message;
	} finally {
		settingsSaving.value = false;
	}
}
function addUpsellRule() {
	upsellConfig.rules.push({ name: null, trigger_item: "", enabled: 1, candidates: [] });
}
function removeUpsellRule(index) {
	upsellConfig.rules.splice(index, 1);
}
function addUpsellCandidate(rule) {
	rule.candidates ||= [];
	rule.candidates.push({ item: "", cashier_phrase: "" });
}
function removeUpsellCandidate(rule, index) {
	rule.candidates.splice(index, 1);
}
async function saveUpsellRules() {
	upsellSaving.value = true;
	upsellMessage.value = "";
	try {
		const result = await call(
			"raspechatka.api.sales.save_pos_upsell_rules",
			{ data: JSON.stringify({ rules: upsellConfig.rules }) },
			{ method: "POST" }
		);
		upsellConfig.catalog_items = result.catalog_items || upsellConfig.catalog_items;
		upsellConfig.rules = (result.rules || []).map((rule) => ({
			...rule,
			candidates: (rule.candidates || []).map((candidate) => ({ ...candidate })),
		}));
		upsellMessage.value = "Дополнительные продажи сохранены";
	} catch (e) {
		upsellMessage.value = e.message;
	} finally {
		upsellSaving.value = false;
	}
}
async function openRow(row) {
	if (kind.value === "shifts")
		selectedDoc.value = await call("raspechatka.api.sales.get_shift", { name: row.name });
	if (kind.value === "receipts" || kind.value === "returns")
		selectedDoc.value = await call("raspechatka.api.sales.get_receipt", { name: row.name });
}
async function provision(point, rotate = false) {
	const result = await call(
		"raspechatka.api.sales.provision_connection",
		{ business_point: point, rotate: rotate ? 1 : 0 },
		{ method: "POST" }
	);
	token.value = result;
	await load();
}
watch(kind, (value) => {
	listRequests.invalidate();
	rows.value = [];
	totals.value = {};
	selectedDoc.value = null;
	error.value = "";
	loading.value = true;
	if (value === "integration") void load();
});
onMounted(init);
</script>
<template>
	<section class="page sales-page">
		<ListPageHeader :title="cfg[kind].title" />
		<SmartFilterBar
			v-if="kind !== 'integration'"
			:key="kind"
			:model-value="filters"
			:entity-fields="entityFields"
			:view-key="`sales.${kind}`"
			@update:model-value="Object.assign(filters, $event)"
			@apply="load"
			@reset="load"
			@ready="load"
		/>
		<div v-if="loading && !rows.length" class="table-message">
			<span class="loader"></span><span>Загружаем продажи…</span>
		</div>
		<div v-else-if="error && !rows.length" class="table-message error-message">
			<strong>Не удалось загрузить данные</strong><span>{{ error }}</span
			><button @click="load">Повторить</button>
		</div>
		<template v-else-if="kind === 'overview'"
			><div class="sales-kpis">
				<article class="accent">
					<small>ЧИСТАЯ ВЫРУЧКА</small><b>{{ money(totals.revenue) }}</b
					><span>за выбранный период</span>
				</article>
				<article>
					<small>ЧЕКОВ</small><b>{{ totals.receipt_count || 0 }}</b
					><span>во всех точках</span>
				</article>
				<article>
					<small>СКИДКИ</small><b>{{ money(totals.discounts) }}</b
					><span>включая отзывы и клуб</span>
				</article>
				<article>
					<small>ВОЗВРАТЫ</small><b>{{ money(totals.returns) }}</b
					><span>вычтены из выручки</span>
				</article>
			</div>
			<div class="point-grid">
				<article v-for="r in rows" :key="r.name">
					<header>
						<div>
							<small>{{ r.city }}</small>
							<h2>{{ r.point_name }}</h2>
						</div>
						<span
							class="connection-status"
							:class="{
								connected: r.connection?.status === 'В сети',
								error: r.connection?.status === 'Ошибка',
							}"
							>{{ r.connection?.status || "Не подключена" }}</span
						>
					</header>
					<div class="point-stats">
						<span
							>Выручка <b>{{ money(r.revenue) }}</b></span
						><span
							>Чеки <b>{{ r.receipt_count }}</b></span
						><span
							>Средний чек <b>{{ money(r.average_check) }}</b></span
						><span
							>Денег в кассе <b>{{ money(r.cash_balance) }}</b></span
						>
					</div>
					<footer>
						<span>{{
							r.open_shift
								? "Смена открыта " + date(r.open_shift.opened_at)
								: "Нет открытой смены"
						}}</span
						><span>Синхронизация: {{ date(r.connection?.last_sync_at) }}</span>
					</footer>
				</article>
			</div></template
		>
		<template v-else-if="kind === 'integration'"
			><div class="form-section pos-global-settings">
				<h2>Общие настройки продаж</h2>
				<h3>Продажи</h3>
				<div class="form-grid checks-grid">
					<label class="check-field"
						><input
							v-model="posSettings.allow_free_price"
							type="checkbox"
							:true-value="1"
							:false-value="0"
							:disabled="!canEditIntegration"
						/>Разрешить изменение цены позиции</label
					>
					<label class="check-field"
						><input
							v-model="posSettings.allow_discounts"
							type="checkbox"
							:true-value="1"
							:false-value="0"
							:disabled="!canEditIntegration"
						/>Разрешить скидки</label
					>
					<label
						>Максимальная скидка, %<input
							v-model.number="posSettings.max_discount_percent"
							type="number"
							min="0"
							max="100"
							:disabled="!canEditIntegration || !posSettings.allow_discounts"
					/></label>
					<label
						>Скидка за один отзыв, ₽<input
							v-model.number="posSettings.review_discount_per_review"
							type="number"
							min="0"
							step="0.01"
							:disabled="!canEditIntegration || !posSettings.allow_discounts"
					/></label>
					<label class="check-field"
						><input
							v-model="posSettings.allow_remove_cart_item"
							type="checkbox"
							:true-value="1"
							:false-value="0"
							:disabled="!canEditIntegration"
						/>Разрешить удаление позиции из корзины</label
					>
				</div>
				<h3>Индикация наценки</h3>
				<div class="form-grid">
					<label
						>Красная / жёлтая граница, %<input
							v-model.number="posSettings.markup_lower_threshold"
							type="number"
							min="0"
							:disabled="!canEditIntegration"
					/></label>
					<label
						>Жёлтая / зелёная граница, %<input
							v-model.number="posSettings.markup_upper_threshold"
							type="number"
							min="0"
							:disabled="!canEditIntegration"
					/></label>
				</div>
				<h3>Способы оплаты</h3>
				<div class="form-grid checks-grid">
					<label class="check-field"
						><input
							v-model="posSettings.accepts_cash"
							type="checkbox"
							:true-value="1"
							:false-value="0"
							:disabled="!canEditIntegration"
						/>Наличные</label
					>
					<label class="check-field"
						><input
							v-model="posSettings.accepts_card"
							type="checkbox"
							:true-value="1"
							:false-value="0"
							:disabled="!canEditIntegration"
						/>Карта</label
					>
					<label class="check-field"
						><input
							v-model="posSettings.accepts_qr"
							type="checkbox"
							:true-value="1"
							:false-value="0"
							:disabled="!canEditIntegration"
						/>QR</label
					>
				</div>
				<div v-if="canEditIntegration" class="footer-actions">
					<span>{{ settingsMessage }}</span
					><button
						class="button button-primary"
						:disabled="settingsSaving"
						@click="savePosSettings"
					>
						{{ settingsSaving ? "Сохраняем…" : "Сохранить настройки" }}
					</button>
				</div>
			</div>
			<div class="form-section upsell-settings">
				<h2>Дополнительные продажи</h2>
				<p class="form-help">
					Правила общие для всех касс сети. На кассе одновременно показывается одно предложение.
				</p>
				<div class="upsell-rules">
					<div v-if="!upsellConfig.rules.length" class="table-message">
						Правила ещё не настроены.
					</div>
					<article v-for="(rule, ruleIndex) in upsellConfig.rules" :key="rule.name || `new-${ruleIndex}`" class="upsell-rule">
						<div class="upsell-rule__header">
							<label class="check-field">
								<input
									v-model="rule.enabled"
									type="checkbox"
									:true-value="1"
									:false-value="0"
									:disabled="!canEditIntegration"
								/>Включено</label
							>
							<button
								v-if="canEditIntegration"
								class="text-button"
								type="button"
								@click="removeUpsellRule(ruleIndex)"
							>
								Удалить правило
							</button>
						</div>
						<label
							>Основная позиция<select
								v-model="rule.trigger_item"
								:disabled="!canEditIntegration"
							>
								<option value="">Выберите позицию</option>
								<option
									v-for="item in upsellConfig.catalog_items"
									:key="item.name"
									:value="item.name"
									>{{ item.item_name }} · {{ item.item_type }}</option
								>
							</select></label
						>
						<div class="upsell-candidates">
							<div
								v-for="(candidate, candidateIndex) in rule.candidates"
								:key="`${rule.name || ruleIndex}-${candidateIndex}`"
								class="upsell-candidate"
							>
								<label
									>Кандидат<select
										v-model="candidate.item"
										:disabled="!canEditIntegration"
									>
										<option value="">Выберите позицию</option>
										<option
											v-for="item in upsellConfig.catalog_items"
											:key="item.name"
											:value="item.name"
											>{{ item.item_name }} · {{ item.item_type }}</option
										>
									</select></label
								>
								<label
									>Фраза кассиру<textarea
										v-model="candidate.cashier_phrase"
										rows="2"
										placeholder="Оставьте пустым для стандартной фразы"
										:disabled="!canEditIntegration"
									></textarea></label
								>
								<button
									v-if="canEditIntegration"
									class="text-button"
									type="button"
									@click="removeUpsellCandidate(rule, candidateIndex)"
								>
									Удалить
								</button>
							</div>
						</div>
						<button
							v-if="canEditIntegration"
							class="text-button"
							type="button"
							@click="addUpsellCandidate(rule)"
						>
							＋ Добавить кандидата
						</button>
				</article>
				</div>
				<div class="upsell-actions">
					<button
						v-if="canEditIntegration"
						class="button button-secondary"
						type="button"
						@click="addUpsellRule"
					>
						＋ Добавить правило
					</button>
					<div v-if="canEditIntegration" class="footer-actions">
						<span>{{ upsellMessage }}</span
						><button
							class="button button-primary"
							:disabled="upsellSaving"
							@click="saveUpsellRules"
						>
							{{ upsellSaving ? "Сохраняем…" : "Сохранить дополнительные продажи" }}
						</button>
					</div>
				</div>
			</div>
			<div class="bank-security-note">
				<span>✓</span>
				<div>
					<b>Токен показывается один раз</b>
					<p>
						Каждая касса привязана к одной точке. Пакеты принимаются идемпотентно:
						повторная отправка не создаёт дублей.
					</p>
				</div>
			</div>
			<div class="bank-connections">
				<article v-for="p in options.points" :key="p.name">
					<div>
						<small>{{ p.city }}</small>
						<h3>{{ p.point_name }}</h3>
						<span>{{
							rows.find((x) => x.business_point === p.name)?.device_id ||
							"Касса ещё не зарегистрирована"
						}}</span>
					</div>
					<span
						class="connection-status"
						:class="{
							connected:
								rows.find((x) => x.business_point === p.name)?.status === 'В сети',
						}"
						>{{
							rows.find((x) => x.business_point === p.name)?.status ||
							"Не подключена"
						}}</span
					>
					<div class="connection-actions">
						<button
							class="button button-primary"
							@click="
								provision(p.name, !!rows.find((x) => x.business_point === p.name))
							"
						>
							{{
								rows.find((x) => x.business_point === p.name)
									? "Перевыпустить токен"
									: "Подключить кассу"
							}}
						</button>
					</div>
				</article>
			</div>
			<div v-if="token" class="token-panel">
				<b>Сохраните реквизиты подключения сейчас</b
				><code>Device ID: {{ token.device_id }}<br />Token: {{ token.token }}</code
				><button @click="token = null">Я сохранил</button>
			</div></template
		>
		<template v-else
			><SmartDataTable
				:rows="rows"
				:entity-fields="entityFields"
				:totals="tableTotals"
				:view-key="`sales.${kind}`"
				:loading="loading"
				:error="error"
				empty-title="Данных пока нет"
				empty-text="Они появятся после первой синхронизации кассовой программы."
				@open="openRow"
				@retry="load"
		/></template>
		<AppModal
			v-if="selectedDoc"
			:title="
				selectedDoc.receipt_type
					? (selectedDoc.receipt_type === 'Return' ? 'Возврат ' : 'Продажа ') +
					  selectedDoc.name
					: 'Смена ' + selectedDoc.name
			"
			wide
			@close="selectedDoc = null"
			><template v-if="selectedDoc.receipt_type"
				><div class="document-summary">
					<span
						>Точка <b>{{ pointMap[selectedDoc.business_point] }}</b></span
					><span
						>Кассир <b>{{ employeeMap[selectedDoc.cashier] || "—" }}</b></span
					><span
						>Время <b>{{ date(selectedDoc.posting_datetime) }}</b></span
					><span
						>Итого <b>{{ money(selectedDoc.total_amount) }}</b></span
					>
				</div>
				<table>
					<thead>
						<tr>
							<th>Наименование</th>
							<th>Количество</th>
							<th>Цена</th>
							<th>Скидка</th>
							<th>Сумма</th>
							<th>Себестоимость</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="x in selectedDoc.items" :key="x.name">
							<td class="item-name">{{ x.item_name }}</td>
							<td>{{ x.quantity }} {{ x.uom }}</td>
							<td>{{ money(x.unit_price) }}</td>
							<td>{{ money(x.discount_amount) }}</td>
							<td>{{ money(x.line_total) }}</td>
							<td>{{ money(x.cost_amount) }}</td>
						</tr>
					</tbody>
				</table></template
			><template v-else
				><div class="document-summary">
					<span>Точка <b>{{ pointMap[selectedDoc.business_point] || selectedDoc.business_point }}</b></span>
					<span>Кассир <b>{{ employeeMap[selectedDoc.cashier] || selectedDoc.cashier || "—" }}</b></span>
					<span>Тип <b>{{ selectedDoc.shift_type || "—" }}</b></span>
					<span>Статус <b>{{ selectedDoc.status }}</b></span>
					<span>Открыта <b>{{ date(selectedDoc.opened_at) }}</b></span>
					<span>Закрыта <b>{{ date(selectedDoc.closed_at) }}</b></span>
				</div>
				<div class="shift-detail-kpis">
					<span
						>Продажи до скидок <b>{{ money(selectedDoc.sales_before_discount) }}</b></span
					><span
						>Скидки <b>{{ money(selectedDoc.discounts_total) }}</b></span
					><span>Скидки за отзывы <b>{{ money(selectedDoc.review_discounts) }}</b></span
					><span>Прочие скидки <b>{{ money(selectedDoc.other_discounts) }}</b></span
					><span>Чеков со скидкой <b>{{ selectedDoc.discounted_receipt_count || 0 }} ({{ Number(selectedDoc.discount_conversion || 0).toFixed(1) }}%)</b></span
					><span
						>Продажи после скидок <b>{{ money(selectedDoc.gross_sales) }}</b></span
					><span
						>Возвраты <b>{{ money(selectedDoc.returns_total) }}</b></span
					><span>Чистая выручка <b>{{ money(selectedDoc.net_sales) }}</b></span
					><span>Чеков <b>{{ selectedDoc.receipt_count }}</b></span
					><span>Средний чек <b>{{ money(selectedDoc.average_check) }}</b></span
					><span>Отзывы <b>{{ selectedDoc.reviews_count || 0 }}</b></span
					><span>Клуб <b>{{ selectedDoc.club_registrations || 0 }}</b></span
					><span>Подарки <b>{{ selectedDoc.gift_orders || 0 }} ({{ selectedDoc.gift_orders_1 || 0 }}/{{ selectedDoc.gift_orders_2 || 0 }}/{{ selectedDoc.gift_orders_3 || 0 }})</b></span
					><span>Наличные <b>{{ money(selectedDoc.cash_sales) }}</b></span
					><span>Карта <b>{{ money(selectedDoc.card_sales) }}</b></span
					><span>QR <b>{{ money(selectedDoc.qr_sales) }}</b></span
					><span>При открытии <b>{{ money(selectedDoc.opening_cash) }}</b></span
					><span>Ожидается <b>{{ money(selectedDoc.expected_cash) }}</b></span
					><span>При закрытии <b>{{ money(selectedDoc.closing_cash) }}</b></span
					>
				</div>
				<h3>Документы смены</h3>
				<table>
					<thead>
						<tr>
							<th>Время</th>
							<th>Тип</th>
							<th>Оплата</th>
							<th>Скидка</th>
							<th>Итого</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="x in selectedDoc.receipts" :key="x.name">
							<td>{{ date(x.posting_datetime) }}</td>
							<td>{{ x.receipt_type === "Sale" ? "Продажа" : "Возврат" }}</td>
							<td>{{ fmt(x.payments, { format: "payment" }) }}</td>
							<td>{{ money(x.discount_amount) }}</td>
							<td>{{ money(x.total_amount) }}</td>
						</tr>
					</tbody>
				</table>
				<h3>Движение наличных</h3>
				<table>
					<thead><tr><th>Время</th><th>Операция</th><th>Сумма</th><th>Причина</th></tr></thead>
					<tbody><tr v-for="x in selectedDoc.cash_movements" :key="x.name"><td>{{ date(x.posting_datetime) }}</td><td>{{ x.movement_type === "Deposit" ? "Внесение" : "Выплата" }}</td><td>{{ money(x.amount) }}</td><td>{{ x.reason || "—" }}</td></tr></tbody>
				</table>
				<h3>Действия кассира</h3>
				<table>
					<thead><tr><th>Время</th><th>Действие</th><th>Количество</th><th>Подробности</th></tr></thead>
					<tbody><tr v-for="x in selectedDoc.actions" :key="x.name"><td>{{ date(x.action_datetime) }}</td><td>{{ actionLabel(x.action_type) }}</td><td>{{ x.metric_value || 0 }}</td><td>{{ x.details || x.reference_document || "—" }}</td></tr></tbody>
				</table></template
			></AppModal
		>
	</section>
</template>
<style scoped>
.upsell-settings { display: grid; gap: 12px; }
.upsell-settings .form-help { margin: -4px 0 4px; color: var(--muted); }
.upsell-rules { display: grid; gap: 12px; }
.upsell-rule { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: #fff; }
.upsell-rule__header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.upsell-candidates { display: grid; gap: 8px; }
.upsell-candidate { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(220px, 1.5fr) auto; gap: 10px; align-items: end; }
.upsell-candidate label, .upsell-rule > label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
.upsell-actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
@media (max-width: 760px) {
	.upsell-candidate { grid-template-columns: 1fr; }
	.upsell-actions { align-items: stretch; flex-direction: column; }
}
</style>
