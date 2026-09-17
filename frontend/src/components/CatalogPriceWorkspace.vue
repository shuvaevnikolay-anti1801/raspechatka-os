<script setup>
import { computed, reactive, ref, watch } from "vue";
import { call } from "../api";
import AppModal from "./AppModal.vue";

const props = defineProps({
	rows: { type: Array, default: () => [] },
	points: { type: Array, default: () => [] },
	businessPoint: { type: String, required: true },
	catalogGroup: { type: String, default: "" },
	groupLabel: { type: String, default: "Все позиции" },
	canEdit: Boolean,
	loading: Boolean,
});
const emit = defineEmits(["reload", "error", "feedback", "dirty"]);
const saving = reactive(new Set());
const sourcePoint = ref("");
const modal = ref("");
const preview = ref(null);
const applying = ref(false);
const calculator = reactive({
	mode: "change",
	base: "current",
	operation: "add",
	unit: "percent",
	value: 10,
	rounding_step: 1,
	rounding_mode: "nearest",
	skip_without_cost: 1,
	not_below_cost: 1,
	min_price: "",
	max_price: "",
	only_markup_below: "",
});
const availableSources = computed(() =>
	props.points.filter((p) => p.name !== props.businessPoint)
);
const pointLabel = computed(
	() =>
		props.points.find((p) => p.name === props.businessPoint)?.point_name || props.businessPoint
);
const sourceLabel = computed(
	() => props.points.find((p) => p.name === sourcePoint.value)?.point_name || sourcePoint.value
);
const money = (value) =>
	value == null
		? "—"
		: `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value)} ₽`;
const markup = (row) =>
	row.cost && row.rate != null
		? ((Number(row.rate) - Number(row.cost)) / Number(row.cost)) * 100
		: null;
const markupClass = (row) => {
	const value = markup(row);
	if (value == null) return "neutral";
	if (value < row.markup_lower_threshold) return "danger";
	if (value < row.markup_upper_threshold) return "warning";
	return "success";
};
const isDirty = (row) => {
	if (row.rate == null && row.saved_rate == null) return false;
	if (row.rate == null || row.rate === "" || row.saved_rate == null) return true;
	return Number(row.rate) !== Number(row.saved_rate);
};
function publishDirty() {
	emit("dirty", props.rows.some(isDirty));
}
watch(() => props.rows, publishDirty, { deep: true });
watch(
	() => props.businessPoint,
	() => {
		sourcePoint.value = "";
	}
);
async function save(row) {
	if (saving.has(row.name)) return;
	saving.add(row.name);
	try {
		await call(
			"raspechatka.api.catalog_layers.save_point_price",
			{
				business_point: props.businessPoint,
				item: row.name,
				rate: row.rate,
				price_type: row.price_type,
				uom: row.stock_uom,
			},
			{ method: "POST" }
		);
		emit("feedback", `Цена для «${row.item_name}» сохранена.`);
		emit("reload");
	} catch (error) {
		emit("error", error.message);
	} finally {
		saving.delete(row.name);
	}
}
async function previewCopy() {
	if (!sourcePoint.value) return;
	try {
		preview.value = await call("raspechatka.api.catalog_pricing.preview_copy_prices", {
			business_point: props.businessPoint,
			source_point: sourcePoint.value,
			catalog_group: props.catalogGroup,
		});
		modal.value = "copy";
	} catch (error) {
		emit("error", error.message);
	}
}
async function previewCalculator() {
	try {
		preview.value = await call("raspechatka.api.catalog_pricing.preview_calculated_prices", {
			business_point: props.businessPoint,
			catalog_group: props.catalogGroup,
			spec: JSON.stringify(calculator),
		});
		modal.value = "calculator-preview";
	} catch (error) {
		emit("error", error.message);
	}
}
async function applyPreview() {
	if (applying.value || !preview.value) return;
	applying.value = true;
	const isCopy = modal.value === "copy";
	try {
		const result = await call(
			isCopy
				? "raspechatka.api.catalog_pricing.apply_copy_prices"
				: "raspechatka.api.catalog_pricing.apply_calculated_prices",
			{
				business_point: props.businessPoint,
				catalog_group: props.catalogGroup,
				preview_token: preview.value.token,
				...(isCopy
					? { source_point: sourcePoint.value }
					: { spec: JSON.stringify(calculator) }),
			},
			{ method: "POST" }
		);
		modal.value = "";
		emit("feedback", `Обновлено цен: ${result.updated}.`);
		emit("reload");
	} catch (error) {
		emit("error", error.message);
	} finally {
		applying.value = false;
	}
}
</script>

<template>
	<div class="price-workspace">
		<div v-if="canEdit" class="price-tools">
			<select v-model="sourcePoint">
				<option value="">Точка-источник…</option>
				<option v-for="point in availableSources" :key="point.name" :value="point.name">
					{{ point.point_name }}
				</option>
			</select>
			<button class="button button-secondary" :disabled="!sourcePoint" @click="previewCopy">
				Копировать цены
			</button>
			<button class="button button-secondary" @click="modal = 'calculator'">
				Калькулятор цен
			</button>
		</div>
		<div class="layer-table-wrap">
			<table class="layer-table">
				<thead>
					<tr>
						<th>Позиция</th>
						<th>Тип / группа</th>
						<th>Закупочная цена</th>
						<th>Цена продажи</th>
						<th>Наценка</th>
						<th v-if="canEdit">Сохранить</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="row in rows" :key="row.name">
						<td>
							<strong>{{ row.item_name }}</strong
							><small>{{ row.item_code || row.name }}</small>
						</td>
						<td>
							{{ row.item_type
							}}<small>{{ row.catalog_group || "Без группы" }}</small>
						</td>
						<td>{{ money(row.cost) }}</td>
						<td>
							<input
								v-model.number="row.rate"
								type="number"
								min="0"
								step="0.01"
								:disabled="!canEdit || saving.has(row.name)"
								@input="publishDirty"
							/>
							₽
						</td>
						<td>
							<span class="markup-badge" :class="markupClass(row)">{{
								markup(row) == null ? "—" : `${markup(row).toFixed(1)} %`
							}}</span>
						</td>
						<td v-if="canEdit">
							<button
								class="button button-primary"
								:disabled="saving.has(row.name) || !isDirty(row)"
								@click="save(row)"
							>
								Сохранить
							</button>
						</td>
					</tr>
					<tr v-if="!loading && !rows.length">
						<td colspan="6">В выбранной группе нет позиций ассортимента.</td>
					</tr>
				</tbody>
			</table>
			<p v-if="loading" class="muted-copy">Загрузка…</p>
		</div>
		<AppModal v-if="modal === 'calculator'" title="Калькулятор цен" wide @close="modal = ''">
			<p>
				<b>Точка:</b> {{ pointLabel }} · <b>Группа:</b> {{ groupLabel }} · <b>Позиций:</b>
				{{ rows.length }}
			</p>
			<div class="calculator-grid">
				<label
					>Режим<select v-model="calculator.mode">
						<option value="change">Изменить базовую цену</option>
						<option value="markup">Установить наценку</option>
					</select></label
				>
				<label v-if="calculator.mode === 'change'"
					>База<select v-model="calculator.base">
						<option value="current">Текущая цена</option>
						<option value="cost">Себестоимость</option>
					</select></label
				>
				<label v-if="calculator.mode === 'change'"
					>Действие<select v-model="calculator.operation">
						<option value="add">Увеличить</option>
						<option value="subtract">Уменьшить</option>
					</select></label
				>
				<label v-if="calculator.mode === 'change'"
					>Единица<select v-model="calculator.unit">
						<option value="percent">%</option>
						<option value="ruble">₽</option>
					</select></label
				>
				<label
					>{{ calculator.mode === "markup" ? "Наценка, %" : "Значение"
					}}<input v-model.number="calculator.value" type="number"
				/></label>
				<label
					>Шаг округления, ₽<input
						v-model.number="calculator.rounding_step"
						type="number"
						min="0"
						list="rounding-steps" /><datalist id="rounding-steps">
						<option value="0">Без округления</option>
						<option value="1" />
						<option value="10" />
						<option value="50" />
						<option value="100" /></datalist
				></label>
				<label
					>Направление<select v-model="calculator.rounding_mode">
						<option value="nearest">Ближайшее</option>
						<option value="up">Вверх</option>
						<option value="down">Вниз</option>
					</select></label
				>
			</div>
			<details class="conditions">
				<summary>Дополнительные условия</summary>
				<div class="calculator-grid">
					<label
						>Минимальная цена<input
							v-model="calculator.min_price"
							type="number"
							min="0" /></label
					><label
						>Максимальная цена<input
							v-model="calculator.max_price"
							type="number"
							min="0" /></label
					><label
						>Только при наценке ниже, %<input
							v-model="calculator.only_markup_below"
							type="number" /></label
					><label class="check"
						><input
							v-model="calculator.skip_without_cost"
							type="checkbox"
							:true-value="1"
							:false-value="0"
						/>Пропускать без себестоимости</label
					><label class="check"
						><input
							v-model="calculator.not_below_cost"
							type="checkbox"
							:true-value="1"
							:false-value="0"
						/>Не ниже себестоимости</label
					>
				</div>
			</details>
			<template #footer
				><button class="button button-secondary" @click="modal = ''">Отмена</button
				><button class="button button-primary" @click="previewCalculator">
					Предпросмотр
				</button></template
			>
		</AppModal>
		<AppModal
			v-if="modal === 'copy' || modal === 'calculator-preview'"
			title="Предпросмотр изменения цен"
			wide
			@close="modal = ''"
		>
			<p>
				<b>Точка назначения:</b> {{ pointLabel }} · <b>Группа:</b> {{ groupLabel
				}}<template v-if="modal === 'copy'">
					· <b>Источник:</b> {{ sourceLabel }}</template
				>
			</p>
			<p>
				Будет изменено: <b>{{ preview.summary.changed }}</b
				>; без изменений: {{ preview.summary.unchanged }}; пропущено:
				{{ preview.summary.skipped }}.
			</p>
			<div class="preview-list">
				<div class="preview-head">
					<b>Позиция</b><b>Закупочная цена</b><b>Текущая</b><b>Новая</b
					><b>Наценка была</b><b>Наценка станет</b><b>Результат</b>
				</div>
				<div v-for="row in preview.rows" :key="row.item">
					<span>{{ row.item_name }}</span
					><span>{{ money(row.cost) }}</span
					><span>{{ money(row.current_rate) }}</span
					><span>{{ money(row.new_rate) }}</span
					><span>{{
						row.current_markup == null ? "—" : `${row.current_markup.toFixed(1)} %`
					}}</span
					><span>{{
						row.new_markup == null ? "—" : `${row.new_markup.toFixed(1)} %`
					}}</span
					><small>{{ row.reason || row.status }}</small>
				</div>
			</div>
			<template #footer
				><button class="button button-secondary" @click="modal = ''">Отмена</button
				><button
					class="button button-primary"
					:disabled="applying || !preview.summary.changed"
					@click="applyPreview"
				>
					{{
						applying
							? "Применяем…"
							: modal === "copy"
							? "Скопировать цены"
							: "Применить новые цены"
					}}
				</button></template
			>
		</AppModal>
	</div>
</template>

<style scoped>
.price-tools {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
	margin-bottom: 12px;
}
.layer-table-wrap {
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
}
.layer-table th {
	background: #fafbf9;
	color: var(--muted);
	font-size: 12px;
}
.layer-table small {
	display: block;
	color: var(--muted);
	margin-top: 3px;
}
.markup-badge {
	display: inline-block;
	padding: 4px 8px;
	border-radius: 999px;
}
.markup-badge.danger {
	background: #fee2e2;
	color: #991b1b;
}
.markup-badge.warning {
	background: #fef3c7;
	color: #92400e;
}
.markup-badge.success {
	background: var(--green-soft);
	color: var(--green-dark);
}
.markup-badge.neutral {
	background: #f3f4f6;
	color: var(--muted);
}
.calculator-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 12px;
}
.calculator-grid label {
	display: grid;
	gap: 5px;
}
.calculator-grid .check {
	display: flex;
	align-items: center;
}
.conditions {
	margin-top: 14px;
}
.conditions summary {
	cursor: pointer;
	font-weight: 600;
}
.conditions .calculator-grid {
	margin-top: 12px;
}
.preview-list {
	max-height: 48vh;
	overflow: auto;
	min-width: 900px;
}
.preview-list > div {
	display: grid;
	grid-template-columns: 2fr repeat(5, 1fr) 1.5fr;
	gap: 8px;
	padding: 8px;
	border-bottom: 1px solid var(--border);
}
.preview-head {
	position: sticky;
	top: 0;
	background: #fff;
}
.modal-body {
	overflow: auto;
}
@media (max-width: 700px) {
	.calculator-grid {
		grid-template-columns: 1fr;
	}
}
</style>
