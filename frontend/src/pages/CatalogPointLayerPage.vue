<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { call, canAccess } from "../api";
import { pageLabel } from "../pageRegistry";
import CatalogGroupSidebar from "../components/CatalogGroupSidebar.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import {
	layerEmptyMessage,
	normalizeBusinessPoint,
	priceSourceLabel,
} from "../catalogPointLayerState";

const route = useRoute();
const layer = computed(() => route.meta.layer || "assortment");
const config = computed(
	() =>
		({
			assortment: {
				title: pageLabel("/catalog/assortment"),
				area: "page.catalog.assortment",
			},
			prices: { title: pageLabel("/catalog/prices"), area: "page.catalog.prices" },
			minimum_stock: {
				title: pageLabel("/catalog/minimum-stock"),
				area: "page.catalog.minimum-stock",
			},
		}[layer.value])
);
const options = reactive({ points: [], groups: [], price_types: [], warehouses: [] });
const filters = reactive({ business_point: "", catalog_group: "" });
const rows = ref([]);
const groupStates = ref({});
const loading = ref(false);
const error = ref("");
const feedback = ref("");
const saving = ref("");
const savingRows = reactive(new Set());
const canEdit = computed(() => canAccess(config.value.area, "Edit"));
const hasActiveWarehouse = computed(() =>
	options.warehouses.some((warehouse) => warehouse.business_point === filters.business_point)
);
const emptyMessage = computed(() => layerEmptyMessage(layer.value, hasActiveWarehouse.value));

let rowsRequestId = 0;

async function loadOptions() {
	const result = await call("raspechatka.api.catalog_layers.get_options", {
		layer: layer.value,
	});
	Object.assign(options, result);
	filters.business_point = normalizeBusinessPoint(
		layer.value,
		filters.business_point,
		options.points
	);
	if (
		filters.catalog_group &&
		!options.groups.some((group) => group.name === filters.catalog_group)
	) {
		filters.catalog_group = "";
	}
}

async function loadRows() {
	const requestId = ++rowsRequestId;
	rows.value = [];
	if (layer.value !== "assortment") groupStates.value = {};
	if (!filters.business_point) {
		loading.value = false;
		return;
	}
	loading.value = true;
	error.value = "";
	try {
		const result = await call("raspechatka.api.catalog_layers.get_rows", {
			layer: layer.value,
			business_point: filters.business_point,
			catalog_group: filters.catalog_group,
		});
		if (requestId !== rowsRequestId) return;
		rows.value = result;
		if (layer.value === "assortment") {
			const states = await call(
				"raspechatka.api.catalog_layers.get_assortment_group_states",
				{
					business_point: filters.business_point,
				}
			);
			if (requestId !== rowsRequestId) return;
			groupStates.value = states;
		}
	} catch (exception) {
		if (requestId === rowsRequestId) error.value = exception.message;
	} finally {
		if (requestId === rowsRequestId) loading.value = false;
	}
}

async function saveAssortment(row) {
	saving.value = row.name;
	try {
		await call(
			"raspechatka.api.catalog_layers.set_assortment",
			{
				business_point: filters.business_point,
				item: row.name,
				enabled: row.enabled ? 1 : 0,
			},
			{ method: "POST" }
		);
		feedback.value =
			filters.business_point === "__all__"
				? `Настройка позиции изменена во всех доступных точках.`
				: `Настройка позиции сохранена.`;
		await loadRows();
	} catch (exception) {
		error.value = exception.message;
		await loadRows();
	} finally {
		saving.value = "";
	}
}

async function bulk(enabled) {
	const pointCount = filters.business_point === "__all__" ? options.points.length : 1;
	if (
		(!enabled || filters.business_point === "__all__") &&
		!window.confirm(
			`${enabled ? "Включить" : "Выключить"} ${
				rows.value.length
			} позиций в ${pointCount} точках?`
		)
	)
		return;
	saving.value = "bulk";
	error.value = "";
	feedback.value = "";
	try {
		const result = await call(
			"raspechatka.api.catalog_layers.bulk_set_assortment",
			{
				business_point: filters.business_point,
				catalog_group: filters.catalog_group,
				enabled,
			},
			{ method: "POST" }
		);
		feedback.value = `${enabled ? "Включено" : "Выключено"} ${
			result.items
		} позиций; изменено ${result.updated} настроек в ${result.points} точках.`;
		await loadRows();
	} catch (exception) {
		error.value = exception.message;
	} finally {
		saving.value = "";
	}
}

async function savePrice(row) {
	if (savingRows.has(row.name)) return;
	savingRows.add(row.name);
	error.value = "";
	feedback.value = "";
	try {
		await call(
			"raspechatka.api.catalog_layers.save_point_price",
			{
				business_point: filters.business_point,
				item: row.name,
				rate: row.rate,
				price_type: row.price_type,
				uom: row.stock_uom,
			},
			{ method: "POST" }
		);
		feedback.value = `Цена для «${row.item_name}» сохранена.`;
		await loadRows();
	} catch (exception) {
		error.value = exception.message;
	} finally {
		savingRows.delete(row.name);
	}
}

async function saveMinimum(row) {
	if (savingRows.has(row.row_key)) return;
	savingRows.add(row.row_key);
	error.value = "";
	feedback.value = "";
	try {
		await call(
			"raspechatka.api.catalog_layers.save_minimum_stock",
			{
				business_point: filters.business_point,
				item: row.name,
				warehouse: row.warehouse,
				minimum_stock: row.minimum_stock,
				reorder_quantity: row.reorder_quantity,
			},
			{ method: "POST" }
		);
		feedback.value = `Норматив для «${row.item_name}» сохранён.`;
		await loadRows();
	} catch (exception) {
		error.value = exception.message;
	} finally {
		savingRows.delete(row.row_key);
	}
}

function selectGroup(name) {
	filters.catalog_group = name;
	feedback.value = "";
	loadRows();
}
function changePoint() {
	feedback.value = "";
	loadRows();
}
async function setAggregated(row, enabled) {
	row.enabled = enabled ? 1 : 0;
	await saveAssortment(row);
}
watch(layer, async () => {
	feedback.value = "";
	await loadOptions();
	await loadRows();
});
onMounted(async () => {
	try {
		await loadOptions();
		await loadRows();
	} catch (exception) {
		error.value = exception.message;
	}
});
</script>

<template>
	<section class="page layer-page">
		<ListPageHeader :title="config.title" />
		<div class="layer-controls">
			<label
				>Точка продаж
				<select v-model="filters.business_point" @change="changePoint">
					<option v-if="layer === 'assortment'" value="__all__">Все точки</option>
					<option v-for="point in options.points" :key="point.name" :value="point.name">
						{{ point.point_name }}
					</option>
				</select>
			</label>
			<div v-if="layer === 'assortment' && canEdit" class="bulk-actions">
				<button class="button button-secondary" :disabled="saving !== ''" @click="bulk(1)">
					Включить {{ filters.catalog_group ? "группу" : "весь каталог" }}
				</button>
				<button class="button button-secondary" :disabled="saving !== ''" @click="bulk(0)">
					Выключить {{ filters.catalog_group ? "группу" : "весь каталог" }}
				</button>
			</div>
		</div>
		<p v-if="error" class="form-error">{{ error }}</p>
		<p v-if="feedback" class="form-success">{{ feedback }}</p>
		<div class="layer-workspace">
			<CatalogGroupSidebar
				:groups="options.groups"
				:selected="filters.catalog_group"
				:states="layer === 'assortment' ? groupStates : {}"
				@select="selectGroup"
			/>
			<div class="layer-table-wrap">
				<table class="layer-table">
					<thead>
						<tr>
							<th>Позиция</th>
							<th>Тип / группа</th>
							<template v-if="layer === 'assortment'"
								><th>
									{{
										filters.business_point === "__all__"
											? "Доступность по точкам"
											: "Продаётся в точке"
									}}
								</th></template
							>
							<template v-else-if="layer === 'prices'"
								><th>Действующая цена</th>
								<th>Источник</th>
								<th>Сохранить</th></template
							>
							<template v-else
								><th>Склад</th>
								<th>Минимальный остаток</th>
								<th>Пополнить на</th>
								<th>Сохранить</th></template
							>
						</tr>
					</thead>
					<tbody>
						<tr v-for="row in rows" :key="row.row_key || row.name">
							<td>
								<strong>{{ row.item_name }}</strong
								><small>{{ row.item_code || row.name }}</small>
							</td>
							<td>
								{{ row.item_type
								}}<small>{{ row.catalog_group || "Без группы" }}</small>
							</td>
							<template v-if="layer === 'assortment'">
								<td v-if="filters.business_point !== '__all__'">
									<input
										v-model="row.enabled"
										type="checkbox"
										:disabled="!canEdit || saving === row.name"
										:true-value="1"
										:false-value="0"
										@change="saveAssortment(row)"
									/>
								</td>
								<td v-else>
									<button
										class="assortment-state"
										:class="`assortment-state--${row.assortment_state}`"
										:disabled="!canEdit || saving === row.name"
										@click="setAggregated(row, row.assortment_state !== 'all')"
									>
										{{
											row.assortment_state === "all"
												? "✓ Во всех"
												: row.assortment_state === "partial"
												? `◐ В ${row.enabled_points} из ${row.point_count}`
												: "○ Нигде"
										}}
									</button>
								</td>
							</template>
							<template v-else-if="layer === 'prices'">
								<td>
									<input
										v-model.number="row.rate"
										type="number"
										min="0"
										step="0.01"
										:disabled="!canEdit || savingRows.has(row.name)"
									/>
									{{ row.currency }}
								</td>
								<td>{{ priceSourceLabel(row.price_source) }}</td>
								<td>
									<button
										v-if="canEdit"
										class="button button-primary"
										:disabled="savingRows.has(row.name)"
										@click="savePrice(row)"
									>
										Сохранить
									</button>
								</td>
							</template>
							<template v-else>
								<td>
									{{ row.warehouse_name
									}}<small v-if="row.is_assortment_warehouse"
										>Склад ассортимента</small
									>
								</td>
								<td>
									<input
										v-model.number="row.minimum_stock"
										type="number"
										min="0"
										step="any"
										:disabled="!canEdit || savingRows.has(row.row_key)"
									/>
								</td>
								<td>
									<input
										v-model.number="row.reorder_quantity"
										type="number"
										min="0"
										step="any"
										:disabled="!canEdit || savingRows.has(row.row_key)"
									/>
								</td>
								<td>
									<button
										v-if="canEdit"
										class="button button-primary"
										:disabled="!row.warehouse || savingRows.has(row.row_key)"
										@click="saveMinimum(row)"
									>
										Сохранить
									</button>
								</td>
							</template>
						</tr>
						<tr v-if="!loading && !rows.length">
							<td colspan="7">{{ emptyMessage }}</td>
						</tr>
					</tbody>
				</table>
				<p v-if="loading" class="muted-copy">Загрузка…</p>
			</div>
		</div>
	</section>
</template>

<style scoped>
.layer-controls {
	display: flex;
	align-items: end;
	gap: 12px;
	margin-bottom: 14px;
	flex-wrap: wrap;
}
.layer-controls label {
	display: grid;
	gap: 5px;
	min-width: 240px;
	font-size: 12px;
	color: var(--muted);
}
.bulk-actions {
	display: flex;
	gap: 8px;
	margin-left: auto;
}
.layer-workspace {
	display: flex;
	align-items: flex-start;
	gap: 16px;
	min-width: 0;
}
.layer-table-wrap {
	flex: 1;
	min-width: 0;
	overflow: auto;
	border: 1px solid var(--border);
	border-radius: 14px;
	background: #fff;
}
.layer-table {
	width: 100%;
	border-collapse: collapse;
}
.layer-table th,
.layer-table td {
	padding: 11px 12px;
	border-bottom: 1px solid var(--border);
	text-align: left;
	vertical-align: middle;
}
.layer-table th {
	color: var(--muted);
	font-size: 12px;
	background: #fafbf9;
}
.layer-table td small {
	display: block;
	margin-top: 3px;
	color: var(--muted);
}
.layer-table input[type="number"],
.layer-table select {
	min-width: 120px;
}
.form-success {
	color: var(--green-dark);
	background: var(--green-soft);
	padding: 9px 12px;
	border-radius: 10px;
}
.assortment-state {
	border: 0;
	border-radius: 9px;
	padding: 7px 10px;
	cursor: pointer;
	background: #f3f4f1;
	color: var(--muted);
}
.assortment-state--all {
	color: var(--green-dark);
	background: var(--green-soft);
}
.assortment-state--partial {
	color: #8a5a00;
	background: #fff4d6;
}
@media (max-width: 900px) {
	.layer-workspace {
		flex-direction: column;
	}
	.bulk-actions {
		margin-left: 0;
	}
	.layer-table-wrap {
		width: 100%;
	}
}
</style>
