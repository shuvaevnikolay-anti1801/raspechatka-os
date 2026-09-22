<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { call } from "../api";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartDataTable from "../components/SmartDataTable.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";
import { defineEntityFields } from "../entityListSchema";
import { createLatestRequestGate, createListReadyGate } from "../listLoading";
import { formatDateOnly } from "../dateTime";

const viewKey = "warehouse.internal-orders";
const listRequests = createLatestRequestGate();
const listReady = createListReadyGate((size) => load(1, size));
const rows = ref([]);
const totalRows = ref(0);
const currentPage = ref(1);
const pageSize = ref(25);
const loading = ref(true);
const listError = ref("");
const optionsError = ref("");
const options = reactive({ points: [], statuses: [] });
const filters = reactive({
	search: "",
	status: "",
	business_point: "",
});

const quantity = (value) =>
	new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(Number(value || 0));
const date = (value, row) => formatDateOnly(value || row.creation);
const entityFields = computed(() =>
	defineEntityFields([
		{
			key: "search",
			label: "Поиск",
			placeholder: "Номер, товар или комментарий",
			form: false,
			filter: false,
			table: false,
		},
		{
			key: "request_date",
			label: "Дата",
			type: "date",
			form: false,
			filter: false,
			table: { format: date },
		},
		{
			key: "business_point",
			label: "Точка",
			type: "select",
			options: options.points,
			form: false,
			filter: { allLabel: "Все точки" },
			table: { displayKey: "business_point_label" },
		},
		{
			key: "requested_by_employee",
			label: "Сотрудник",
			type: "link",
			displayKey: "requested_by_employee_label",
			form: false,
			filter: false,
			table: true,
		},
		{
			key: "item_name",
			label: "Товар / что требуется",
			searchable: true,
			form: false,
			filter: false,
			table: { primary: true },
		},
		{
			key: "quantity",
			label: "Количество",
			type: "number",
			form: false,
			filter: false,
			table: { number: true, format: quantity },
		},
		{
			key: "comment",
			label: "Комментарий",
			searchable: true,
			form: false,
			filter: false,
			table: true,
		},
		{
			key: "status",
			label: "Статус",
			type: "select",
			options: options.statuses,
			form: false,
			filter: { allLabel: "Все статусы" },
			table: true,
		},
	])
);
const error = computed(() => listError.value || optionsError.value);

async function load(page = 1, size = pageSize.value) {
	const requestId = listRequests.begin();
	currentPage.value = page;
	pageSize.value = size;
	loading.value = true;
	listError.value = "";
	try {
		const start = (page - 1) * size;
		const result = await call("raspechatka.api.internal_orders.get_internal_orders", {
			search: filters.search,
			status: filters.status,
			business_point: filters.business_point,
			start,
			page_length: size,
		});
		if (!listRequests.isCurrent(requestId)) return;
		rows.value = result.rows || [];
		totalRows.value = start + rows.value.length + (result.has_more ? 1 : 0);
	} catch (exception) {
		if (listRequests.isCurrent(requestId)) listError.value = exception.message;
	} finally {
		if (listRequests.isCurrent(requestId)) loading.value = false;
	}
}

async function loadOptions() {
	optionsError.value = "";
	try {
		const result = await call("raspechatka.api.internal_orders.get_internal_order_options");
		options.points = result.points || [];
		options.statuses = result.statuses || [];
	} catch (exception) {
		optionsError.value = exception.message;
	}
}

onMounted(loadOptions);
</script>

<template>
	<section class="page">
		<ListPageHeader title="Внутренние заказы" />
		<SmartFilterBar
			:model-value="filters"
			:entity-fields="entityFields"
			:view-key="viewKey"
			@update:model-value="Object.assign(filters, $event)"
			@apply="load(1)"
			@reset="load(1)"
			@ready="listReady.filter"
		/>
		<SmartDataTable
			:rows="rows"
			:entity-fields="entityFields"
			:loading="loading"
			:error="error"
			:selectable="false"
			:server-pagination="true"
			:total-rows="totalRows"
			:current-page="currentPage"
			:view-key="viewKey"
			empty-title="Внутренних заказов пока нет"
			empty-text="Потребности точки появятся здесь после синхронизации кассы."
			@retry="load(currentPage)"
			@page-change="load"
			@page-size-change="load(1, $event)"
			@ready="listReady.table"
		/>
	</section>
</template>
