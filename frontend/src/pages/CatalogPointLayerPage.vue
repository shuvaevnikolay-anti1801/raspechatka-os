<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { call, canAccess } from "../api";
import { pageLabel } from "../pageRegistry";
import CatalogGroupSidebar from "../components/CatalogGroupSidebar.vue";
import CatalogPointLayerToolbar from "../components/CatalogPointLayerToolbar.vue";
import CatalogPriceWorkspace from "../components/CatalogPriceWorkspace.vue";
import StockNormsWorkspace from "../components/StockNormsWorkspace.vue";
import AppModal from "../components/AppModal.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import { layerEmptyMessage, normalizeBusinessPoint } from "../catalogPointLayerState";

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
		})[layer.value],
);
const options = reactive({ points: [], groups: [], price_types: [], warehouses: [] });
const filters = reactive({ business_point: "", catalog_group: "" });
const rows = ref([]);
const groupStates = ref({});
const loading = ref(false);
const error = ref("");
const feedback = ref("");
const saving = ref("");
const priceDirty = ref(false);
const normsDirty = ref(false);
const priceWorkspace = ref(null);
const normsWorkspace = ref(null);
const sourcePoint = ref("");
const workspaceBusy = ref(false);
const bulkIntent = ref(null);
const previousPoint = ref("");
const canEdit = computed(() => canAccess(config.value.area, "Edit"));
const hasActiveWarehouse = computed(() =>
	options.warehouses.some((warehouse) => warehouse.business_point === filters.business_point),
);
const emptyMessage = computed(() => layerEmptyMessage(layer.value, hasActiveWarehouse.value));
const selectedGroupLabel = computed(
	() =>
		options.groups.find((group) => group.name === filters.catalog_group)?.group_name ||
		"Все позиции",
);
const selectedPointLabel = computed(() =>
	filters.business_point === "__all__"
		? "Все доступные точки"
		: options.points.find((point) => point.name === filters.business_point)?.point_name ||
			filters.business_point,
);

let rowsRequestId = 0;

async function loadOptions() {
	const result = await call("raspechatka.api.catalog_layers.get_options", {
		layer: layer.value,
	});
	Object.assign(options, result);
	filters.business_point = normalizeBusinessPoint(
		layer.value,
		filters.business_point,
		options.points,
	);
	previousPoint.value = filters.business_point;
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
				},
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
			{ method: "POST" },
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
			{ method: "POST" },
		);
		feedback.value = `${enabled ? "Включено" : "Выключено"} ${
			result.items
		} позиций; изменено ${result.updated} настроек в ${result.points} точках.`;
		bulkIntent.value = null;
		await loadRows();
	} catch (exception) {
		error.value = exception.message;
	} finally {
		saving.value = "";
	}
}

function requestBulk(enabled) {
	bulkIntent.value = {
		enabled,
		items: rows.value.length,
		points: filters.business_point === "__all__" ? options.points.length : 1,
	};
}

function selectGroup(name) {
	if (
		((layer.value === "prices" && priceDirty.value) ||
			(layer.value === "minimum_stock" && normsDirty.value)) &&
		!window.confirm("Есть несохранённые изменения. Продолжить без сохранения?")
	)
		return;
	priceDirty.value = false;
	normsDirty.value = false;
	filters.catalog_group = name;
	feedback.value = "";
	loadRows();
}
function changePoint() {
	if (
		((layer.value === "prices" && priceDirty.value) ||
			(layer.value === "minimum_stock" && normsDirty.value)) &&
		!window.confirm("Есть несохранённые изменения. Продолжить без сохранения?")
	) {
		filters.business_point = previousPoint.value;
		return;
	}
	priceDirty.value = false;
	normsDirty.value = false;
	workspaceBusy.value = false;
	sourcePoint.value = "";
	previousPoint.value = filters.business_point;
	feedback.value = "";
	loadRows();
}
async function setAggregated(row, enabled) {
	row.enabled = enabled ? 1 : 0;
	await saveAssortment(row);
}
watch(layer, async () => {
	feedback.value = "";
	sourcePoint.value = "";
	workspaceBusy.value = false;
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
		<CatalogPointLayerToolbar
			v-model:business-point="filters.business_point"
			v-model:source-point="sourcePoint"
			:points="options.points"
			:allow-all="layer === 'assortment'"
			:show-source="canEdit && (layer === 'prices' || layer === 'minimum_stock')"
			:disabled="loading || workspaceBusy"
			@change-point="changePoint"
		>
			<template v-if="canEdit" #actions>
				<template v-if="layer === 'prices'">
					<button
						class="button button-secondary"
						:disabled="!sourcePoint || workspaceBusy"
						@click="priceWorkspace?.previewCopy()"
					>
						{{ workspaceBusy ? "Загрузка…" : "Копировать цены" }}
					</button>
					<button
						class="button button-primary"
						:disabled="workspaceBusy || !rows.length"
						@click="priceWorkspace?.openCalculator()"
					>
						Калькулятор цен
					</button>
				</template>
				<template v-else-if="layer === 'minimum_stock'">
					<button
						class="button button-secondary"
						:disabled="!sourcePoint || workspaceBusy"
						@click="normsWorkspace?.previewCopy()"
					>
						Копировать нормативы
					</button>
					<button
						class="button button-primary"
						:disabled="workspaceBusy || !rows.length"
						@click="normsWorkspace?.openCalculator()"
					>
						Рассчитать нормативы
					</button>
				</template>
				<template v-else-if="layer === 'assortment'">
					<button
						class="button button-secondary"
						:disabled="saving !== ''"
						@click="requestBulk(1)"
					>
						Включить {{ filters.catalog_group ? "группу" : "весь каталог" }}
					</button>
					<button
						class="button button-secondary"
						:disabled="saving !== ''"
						@click="requestBulk(0)"
					>
						Выключить {{ filters.catalog_group ? "группу" : "весь каталог" }}
					</button>
				</template>
			</template>
		</CatalogPointLayerToolbar>
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
				<CatalogPriceWorkspace
					v-if="layer === 'prices'"
					ref="priceWorkspace"
					:rows="rows"
					:points="options.points"
					:business-point="filters.business_point"
					:catalog-group="filters.catalog_group"
					:group-label="selectedGroupLabel"
					:can-edit="canEdit"
					:loading="loading"
					:source-point="sourcePoint"
					@reload="loadRows"
					@dirty="priceDirty = $event"
					@error="error = $event"
					@feedback="feedback = $event"
					@busy="workspaceBusy = $event"
				/>
				<StockNormsWorkspace
					v-else-if="layer === 'minimum_stock'"
					ref="normsWorkspace"
					:rows="rows"
					:points="options.points"
					:business-point="filters.business_point"
					:catalog-group="filters.catalog_group"
					:group-label="selectedGroupLabel"
					:can-edit="canEdit"
					:loading="loading"
					:source-point="sourcePoint"
					@reload="loadRows"
					@dirty="normsDirty = $event"
					@error="error = $event"
					@feedback="feedback = $event"
					@busy="workspaceBusy = $event"
				/>
				<table v-else class="layer-table">
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
						</tr>
						<tr v-if="!loading && !rows.length">
							<td colspan="7">{{ emptyMessage }}</td>
						</tr>
					</tbody>
				</table>
				<p v-if="loading" class="muted-copy">Загрузка…</p>
			</div>
		</div>
		<AppModal
			v-if="bulkIntent"
			:title="bulkIntent.enabled ? 'Включение ассортимента' : 'Выключение ассортимента'"
			@close="bulkIntent = null"
		>
			<div class="bulk-preview">
				<div>
					<span>Точки продаж</span><strong>{{ selectedPointLabel }}</strong>
				</div>
				<div>
					<span>Область</span><strong>{{ selectedGroupLabel }}</strong>
				</div>
				<div>
					<span>Точек</span><strong>{{ bulkIntent.points }}</strong>
				</div>
				<div>
					<span>Позиций</span><strong>{{ bulkIntent.items }}</strong>
				</div>
			</div>
			<p class="bulk-preview__note">
				{{
					bulkIntent.enabled
						? "Позиции станут доступными для продажи в выбранной области."
						: "Позиции перестанут продаваться в выбранной области. Сами карточки каталога сохранятся."
				}}
			</p>
			<template #footer>
				<button
					class="button button-secondary"
					:disabled="saving === 'bulk'"
					@click="bulkIntent = null"
				>
					Отмена
				</button>
				<button
					class="button button-primary"
					:disabled="saving === 'bulk'"
					@click="bulk(bulkIntent.enabled)"
				>
					{{
						saving === "bulk"
							? "Применяем…"
							: bulkIntent.enabled
								? "Включить позиции"
								: "Выключить позиции"
					}}
				</button>
			</template>
		</AppModal>
	</section>
</template>

<style scoped>
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
.bulk-preview {
	display: grid;
	grid-template-columns: 1.5fr 1fr auto auto;
	gap: 12px;
	padding: 14px 16px;
	border: 1px solid var(--border);
	border-radius: 14px;
	background: #fafbf9;
}
.bulk-preview > div {
	display: grid;
	gap: 3px;
}
.bulk-preview span {
	color: var(--muted);
	font-size: 12px;
}
.bulk-preview__note {
	margin: 14px 2px 0;
	color: var(--muted);
	font-size: 13px;
	line-height: 1.5;
}
@media (max-width: 900px) {
	.layer-workspace {
		flex-direction: column;
	}
	.layer-table-wrap {
		width: 100%;
	}
}
@media (max-width: 620px) {
	.bulk-preview {
		grid-template-columns: 1fr;
	}
}
</style>
