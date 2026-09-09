<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { call } from "../api";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartDataTable from "../components/SmartDataTable.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";

const route = useRoute();
const rows = ref([]);
const totalRows = ref(0);
const currentPage = ref(1);
const pageSize = ref(25);
const loading = ref(true);
const error = ref("");
const options = reactive({ points: [], warehouses: [], groups: [] });
const today = new Date().toISOString().slice(0, 10);
const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
	.toISOString()
	.slice(0, 10);
const filters = reactive({
	from_date: month,
	to_date: today,
	business_point: "",
	warehouse: String(route.query.warehouse || ""),
	search: String(route.query.search || ""),
});
const selectedItem = ref(String(route.query.item || ""));
const visibleWarehouses = computed(() =>
	options.warehouses.filter(
		(row) => !filters.business_point || row.business_point === filters.business_point
	)
);
const filterFields = computed(() => [
	{
		key: "search",
		label: "Товар",
		placeholder: "Название, код или артикул",
		wide: true,
	},
	{ key: "from_date", label: "Период с", type: "date" },
	{ key: "to_date", label: "Период по", type: "date" },
	{
		key: "business_point",
		label: "Точка",
		type: "select",
		allLabel: "Все точки",
		options: options.points.map((row) => ({
			value: row.name,
			label: row.point_name,
		})),
	},
	{
		key: "warehouse",
		label: "Склад",
		type: "select",
		allLabel: "Все склады",
		options: visibleWarehouses.value.map((row) => ({
			value: row.name,
			label: row.warehouse_name,
		})),
	},
]);
const quantity = (value) =>
	new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(Number(value || 0));
const money = (value) =>
	`${new Intl.NumberFormat("ru-RU", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(Number(value || 0))} ₽`;
const date = (value) =>
	value
		? new Intl.DateTimeFormat("ru-RU", {
				dateStyle: "short",
				timeStyle: "short",
		  }).format(new Date(String(value).replace(" ", "T")))
		: "—";
const columns = [
	{ key: "posting_datetime", label: "Дата", format: date },
	{ key: "item_name", label: "Товар", primary: true },
	{ key: "item_code", label: "Код" },
	{ key: "warehouse_name", label: "Склад" },
	{ key: "actual_qty", label: "Движение", number: true, format: quantity },
	{ key: "quantity_before", label: "До", number: true, format: quantity },
	{ key: "quantity_after", label: "После", number: true, format: quantity },
	{ key: "incoming_rate", label: "Себестоимость", number: true, format: money },
	{
		key: "stock_value_difference",
		label: "Стоимость движения",
		number: true,
		format: money,
	},
	{
		key: "stock_value_after",
		label: "Стоимость остатка",
		number: true,
		format: money,
	},
	{ key: "valuation_source", label: "Источник расчёта" },
	{ key: "voucher_no", label: "Исходный документ" },
];

function sourceUrl(row) {
	const slug = String(row.voucher_type || "")
		.trim()
		.toLowerCase()
		.replaceAll(" ", "-");
	return slug && row.voucher_no ? `/app/${slug}/${encodeURIComponent(row.voucher_no)}` : "";
}
async function load(page = 1, size = pageSize.value) {
	currentPage.value = page;
	pageSize.value = size;
	loading.value = true;
	error.value = "";
	try {
		const result = await call("raspechatka.api.warehouse_reports.get_stock_movements", {
			...filters,
			item: selectedItem.value,
			limit_start: (page - 1) * size,
			limit_page_length: size,
		});
		rows.value = result.rows || [];
		totalRows.value = Number(result.total || 0);
	} catch (exception) {
		error.value = exception.message;
	} finally {
		loading.value = false;
	}
}
async function init() {
	try {
		Object.assign(options, await call("raspechatka.api.warehouse_reports.get_report_options"));
		await load();
	} catch (exception) {
		error.value = exception.message;
		loading.value = false;
	}
}
onMounted(init);
</script>

<template>
	<section class="page report-page">
		<ListPageHeader title="Движения товаров" />
		<SmartFilterBar
			:model-value="filters"
			:fields="filterFields"
			view-key="warehouse.movements"
			@update:model-value="
				Object.assign(filters, $event);
				selectedItem = '';
			"
			@apply="load(1)"
			@reset="load(1)"
		/>
		<SmartDataTable
			:rows="rows"
			:columns="columns"
			:loading="loading"
			:error="error"
			:selectable="false"
			:server-pagination="true"
			:total-rows="totalRows"
			:current-page="currentPage"
			view-key="warehouse.movements"
			empty-title="Движений пока нет"
			empty-text="Измените период или фильтры."
			@retry="load(currentPage)"
			@page-change="load"
			@page-size-change="load(1, $event)"
		>
			<template #cell-voucher_no="{ row }">
				<a
					v-if="sourceUrl(row)"
					:href="sourceUrl(row)"
					target="_blank"
					rel="noopener"
					@click.stop
					>{{ row.voucher_no }}</a
				>
				<span v-else>{{ row.voucher_no || "—" }}</span>
			</template>
		</SmartDataTable>
	</section>
</template>
