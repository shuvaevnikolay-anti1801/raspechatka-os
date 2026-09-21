<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { call } from "../api";
import { documentFilterMatches } from "../listDocumentFilters";
import {
	deriveTableColumns,
	reconcileColumnOrder,
	reconcileVisible,
	resolveDisplayValue,
	resolveSortValue,
} from "../entityListSchema";

const props = defineProps({
	rows: { type: Array, default: () => [] },
	columns: { type: Array, default: () => [] },
	entityFields: { type: Array, default: null },
	viewKey: { type: String, required: true },
	loading: Boolean,
	error: String,
	rowKey: { type: String, default: "name" },
	emptyTitle: { type: String, default: "Данных пока нет" },
	emptyText: { type: String, default: "Измените фильтры или создайте первую запись." },
	totals: { type: Object, default: () => ({}) },
	selectable: { type: Boolean, default: true },
	serverPagination: Boolean,
	totalRows: { type: Number, default: 0 },
	currentPage: { type: Number, default: 1 },
});
const emit = defineEmits([
	"open",
	"retry",
	"selection-change",
	"page-change",
	"page-size-change",
	"ready",
]);
const selected = ref([]),
	columnOrder = ref([]),
	selectedRows = ref([]),
	widths = ref({}),
	settingsOpen = ref(false),
	page = ref(1),
	pageSize = ref(25),
	ready = ref(false),
	sort = ref({ key: "", direction: "asc" });
const pageSizes = [25, 50, 100];
const preferenceKey = computed(() => `${props.viewKey}.table`);
const availableColumns = computed(() =>
	props.entityFields ? deriveTableColumns(props.entityFields) : props.columns
);
const visibleColumns = computed(() =>
	columnOrder.value
		.map((key) => availableColumns.value.find((column) => column.key === key))
		.filter((column) => column && selected.value.includes(column.key))
);
const filteredRows = computed(() => {
	const names = documentFilterMatches[props.viewKey];
	if (!Array.isArray(names)) return props.rows;
	const allowed = new Set(names);
	return props.rows.filter((row) => allowed.has(row[props.rowKey]));
});
const hasRows = computed(() => filteredRows.value.length > 0);
const rowCount = computed(() =>
	props.serverPagination ? props.totalRows : filteredRows.value.length
);
const pageCount = computed(() => Math.max(1, Math.ceil(rowCount.value / pageSize.value)));
const sortedRows = computed(() => {
	if (!sort.value.key) return filteredRows.value;
	return [...filteredRows.value].sort((a, b) => {
		const column = availableColumns.value.find((item) => item.key === sort.value.key) || {
			key: sort.value.key,
		};
		const left = resolveSortValue(a, column),
			right = resolveSortValue(b, column);
		const result =
			typeof left === "number" && typeof right === "number"
				? left - right
				: String(left ?? "").localeCompare(String(right ?? ""), "ru", { numeric: true });
		return sort.value.direction === "asc" ? result : -result;
	});
});
const pageRows = computed(() =>
	props.serverPagination
		? sortedRows.value
		: sortedRows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value)
);
const from = computed(() => (rowCount.value ? (page.value - 1) * pageSize.value + 1 : 0));
const to = computed(() =>
	props.serverPagination
		? Math.min(from.value + filteredRows.value.length - 1, rowCount.value)
		: Math.min(page.value * pageSize.value, rowCount.value)
);
const effectiveTotals = computed(() => {
	if (!Array.isArray(documentFilterMatches[props.viewKey])) return props.totals;
	return Object.fromEntries(
		availableColumns.value
			.filter((column) => column.number)
			.map((column) => [
				column.key,
				filteredRows.value.reduce((total, row) => total + Number(row[column.key] || 0), 0),
			])
	);
});
let resizing = null,
	draggingKey = null,
	preferenceGeneration = 0;

function display(row, column) {
	return resolveDisplayValue(row, column);
}
async function savePreference() {
	if (!ready.value) return;
	await call(
		"raspechatka.api.references.save_view_preference",
		{
			view_key: preferenceKey.value,
			settings: JSON.stringify({
				columns: selected.value,
				columnOrder: columnOrder.value,
				schema: availableColumns.value.map((column) => column.key),
				widths: widths.value,
				pageSize: pageSize.value,
			}),
		},
		{ method: "POST" }
	);
}
async function loadPreference() {
	const generation = ++preferenceGeneration;
	const key = preferenceKey.value;
	ready.value = false;
	selected.value = availableColumns.value
		.filter((column) => column.default !== false)
		.map((column) => column.key);
	columnOrder.value = availableColumns.value.map((column) => column.key);
	widths.value = {};
	pageSize.value = 25;
	page.value = 1;
	try {
		const preference = await call("raspechatka.api.references.get_view_preference", {
			view_key: key,
		});
		if (generation !== preferenceGeneration) return;
		selected.value = reconcileVisible(
			preference.columns,
			availableColumns.value,
			"table",
			preference.schema
		);
		columnOrder.value = reconcileColumnOrder(
			preference.columnOrder || preference.columns,
			availableColumns.value
		);
		widths.value = Object.fromEntries(
			Object.entries(preference.widths || {}).filter(([key]) =>
				availableColumns.value.some((column) => column.key === key)
			)
		);
		if (pageSizes.includes(Number(preference.pageSize)))
			pageSize.value = Number(preference.pageSize);
	} catch (_) {
		if (generation !== preferenceGeneration) return;
	}
	if (generation !== preferenceGeneration) return;
	ready.value = true;
	emit("ready", pageSize.value);
}
async function toggleColumn(key) {
	selected.value = selected.value.includes(key)
		? selected.value.length > 1
			? selected.value.filter((item) => item !== key)
			: selected.value
		: [...selected.value, key];
	await savePreference();
}
function beginResize(event, column) {
	event.preventDefault();
	resizing = {
		key: column.key,
		x: event.clientX,
		width: widths.value[column.key] || event.currentTarget.parentElement.offsetWidth,
	};
	window.addEventListener("pointermove", resize);
	window.addEventListener("pointerup", endResize, { once: true });
}
function resize(event) {
	if (resizing)
		widths.value = {
			...widths.value,
			[resizing.key]: Math.max(80, resizing.width + event.clientX - resizing.x),
		};
}
async function endResize() {
	window.removeEventListener("pointermove", resize);
	resizing = null;
	await savePreference();
}
function setPageSize(event) {
	pageSize.value = Number(event.target.value);
	page.value = 1;
	savePreference();
	if (props.serverPagination) emit("page-size-change", pageSize.value);
}
function changePage(nextPage) {
	page.value = nextPage;
	if (props.serverPagination) emit("page-change", nextPage, pageSize.value);
}
function changeSort(key) {
	sort.value =
		sort.value.key === key
			? { key, direction: sort.value.direction === "asc" ? "desc" : "asc" }
			: { key, direction: "asc" };
}
function beginDrag(event, column) {
	if (column.fixed) return;
	draggingKey = column.key;
	event.dataTransfer.effectAllowed = "move";
	event.dataTransfer.setData("text/plain", column.key);
}
function dropColumn(event, target) {
	const source = draggingKey || event.dataTransfer.getData("text/plain");
	draggingKey = null;
	if (!source || source === target.key || target.fixed) return;
	const movable = columnOrder.value.filter((key) => key !== source);
	const targetIndex = movable.indexOf(target.key);
	movable.splice(targetIndex < 0 ? movable.length : targetIndex, 0, source);
	columnOrder.value = movable;
	savePreference();
}
function toggleRow(row) {
	const key = row[props.rowKey];
	selectedRows.value = selectedRows.value.includes(key)
		? selectedRows.value.filter((x) => x !== key)
		: [...selectedRows.value, key];
	emit("selection-change", selectedRows.value);
}
function togglePage() {
	const keys = pageRows.value.map((row) => row[props.rowKey]);
	const all = keys.every((key) => selectedRows.value.includes(key));
	selectedRows.value = all
		? selectedRows.value.filter((key) => !keys.includes(key))
		: [...new Set([...selectedRows.value, ...keys])];
	emit("selection-change", selectedRows.value);
}

watch(() => props.viewKey, loadPreference);
watch(availableColumns, () => {
	selected.value = reconcileVisible(
		selected.value,
		availableColumns.value,
		"table",
		columnOrder.value
	);
	columnOrder.value = reconcileColumnOrder(columnOrder.value, availableColumns.value);
});
watch(
	() => props.currentPage,
	(value) => {
		page.value = value;
	}
);
watch(
	() => filteredRows.value.length,
	() => {
		if (page.value > pageCount.value) page.value = pageCount.value;
	}
);
onMounted(loadPreference);
onBeforeUnmount(() => {
	preferenceGeneration += 1;
	window.removeEventListener("pointermove", resize);
});
</script>

<template>
	<div class="smart-table">
		<div class="table-meta">
			<div class="table-meta-summary">
				<strong>{{
					selectedRows.length ? `Выбрано: ${selectedRows.length}` : `${rowCount} записей`
				}}</strong>
				<span v-if="loading && hasRows" class="table-refresh-state"
					><i class="loader"></i>Обновляем…</span
				>
				<button
					v-else-if="error && hasRows"
					class="table-refresh-error"
					type="button"
					@click="$emit('retry')"
				>
					Не обновилось · Повторить
				</button>
			</div>
			<div class="column-settings">
				<button class="text-button" type="button" @click="settingsOpen = !settingsOpen">
					Настроить столбцы
				</button>
				<div v-if="settingsOpen" class="column-popover">
					<label v-for="column in availableColumns" :key="column.key"
						><input
							type="checkbox"
							:checked="selected.includes(column.key)"
							@change="toggleColumn(column.key)"
						/><span>{{ column.label }}</span></label
					>
				</div>
			</div>
		</div>
		<div class="table-shell">
			<div v-if="error && !hasRows" class="table-message error-message">
				<strong>Не удалось загрузить данные</strong><span>{{ error }}</span
				><button @click="$emit('retry')">Повторить</button>
			</div>
			<div v-else-if="loading && !hasRows" class="table-message">
				<span class="loader"></span><span>Загружаем данные…</span>
			</div>
			<div v-else-if="!hasRows" class="table-message">
				<strong>{{ emptyTitle }}</strong
				><span>{{ emptyText }}</span>
			</div>
			<table v-else>
				<colgroup>
					<col v-if="selectable" class="select-column" />
					<col
						v-for="column in visibleColumns"
						:key="column.key"
						:style="{
							width:
								(widths[column.key] || column.width || 'auto') +
								(typeof (widths[column.key] || column.width) === 'number'
									? 'px'
									: ''),
						}"
					/>
				</colgroup>
				<thead>
					<tr>
						<th v-if="selectable" class="select-cell">
							<input
								type="checkbox"
								:checked="
									pageRows.length &&
									pageRows.every((row) => selectedRows.includes(row[rowKey]))
								"
								aria-label="Выбрать страницу"
								@change="togglePage"
							/>
						</th>
						<th
							v-for="column in visibleColumns"
							:key="column.key"
							@dragover.prevent
							@drop.prevent="dropColumn($event, column)"
						>
							<button
								v-if="!column.fixed"
								class="column-drag-handle"
								type="button"
								draggable="true"
								title="Перетащить столбец"
								aria-label="Перетащить столбец"
								@click.stop
								@dragstart="beginDrag($event, column)"
							>
								⋮⋮</button
							><span @click="changeSort(column.key)"
								>{{ column.label }}
								<i v-if="sort.key === column.key" class="sort-mark">{{
									sort.direction === "asc" ? "↑" : "↓"
								}}</i></span
							><i
								class="column-resizer"
								@click.stop
								@pointerdown="beginResize($event, column)"
							></i>
						</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="row in pageRows"
						:key="row[rowKey]"
						:class="{ selected: selectedRows.includes(row[rowKey]) }"
						tabindex="0"
						@click="$emit('open', row)"
						@keydown.enter="$emit('open', row)"
					>
						<td v-if="selectable" class="select-cell" @click.stop>
							<input
								type="checkbox"
								:checked="selectedRows.includes(row[rowKey])"
								:aria-label="`Выбрать ${row[rowKey]}`"
								@change="toggleRow(row)"
							/>
						</td>
						<td
							v-for="column in visibleColumns"
							:key="column.key"
							:class="[
								{ 'item-name': column.primary, 'number-cell': column.number },
								column.className,
							]"
						>
							<slot
								:name="`cell-${column.key}`"
								:row="row"
								:value="row[column.key]"
								:column="column"
								>{{ display(row, column) }}</slot
							>
						</td>
					</tr>
				</tbody>
				<tfoot v-if="Object.keys(effectiveTotals).length">
					<tr>
						<td v-if="selectable"></td>
						<td
							v-for="column in visibleColumns"
							:key="column.key"
							:class="{ 'number-cell': column.number }"
						>
							<strong v-if="column.primary">Итого</strong
							><strong v-else-if="effectiveTotals[column.key] !== undefined">{{
								column.format
									? column.format(effectiveTotals[column.key], effectiveTotals)
									: effectiveTotals[column.key]
							}}</strong>
						</td>
					</tr>
				</tfoot>
			</table>
		</div>
		<footer class="table-footer">
			<span>{{ from }}–{{ to }} из {{ rowCount }}</span>
			<div class="table-pages">
				<button :disabled="page === 1" @click="changePage(page - 1)">←</button
				><span>{{ page }} / {{ pageCount }}</span
				><button :disabled="page === pageCount" @click="changePage(page + 1)">→</button>
			</div>
			<label
				>Строк на странице<select :value="pageSize" @change="setPageSize">
					<option v-for="size in pageSizes" :key="size" :value="size">{{ size }}</option>
				</select></label
			>
		</footer>
	</div>
</template>

<style scoped>
.table-meta-summary {
	display: flex;
	align-items: center;
	gap: 10px;
	min-width: 0;
}
.table-refresh-state,
.table-refresh-error {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	color: #7a8078;
	font-size: 10px;
	font-weight: 500;
}
.table-refresh-state .loader {
	width: 12px;
	height: 12px;
}
.table-refresh-error {
	padding: 0;
	border: 0;
	background: transparent;
	color: #9a5a43;
	text-decoration: underline;
	text-underline-offset: 2px;
}
</style>
