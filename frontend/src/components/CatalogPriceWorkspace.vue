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
	sourcePoint: { type: String, default: "" },
});
const emit = defineEmits(["reload", "error", "feedback", "dirty", "busy"]);
const saving = reactive(new Set());
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
const pointLabel = computed(
	() =>
		props.points.find((p) => p.name === props.businessPoint)?.point_name ||
		props.businessPoint,
);
const sourceLabel = computed(
	() => props.points.find((p) => p.name === props.sourcePoint)?.point_name || props.sourcePoint,
);
const money = (value) =>
	value == null
		? "—"
		: `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value)} ₽`;
const markup = (row) => {
	if (row.cost == null || row.rate == null || Number(row.cost) === 0) return null;
	return ((Number(row.rate) - Number(row.cost)) / Number(row.cost)) * 100;
};
const markupLabel = (rate, cost, value = null) => {
	if (cost == null) return "—";
	if (rate == null) return "—";
	if (Number(cost) === 0) return rate != null && Number(rate) > 0 ? "∞" : "—";
	const percent = value == null ? ((Number(rate) - Number(cost)) / Number(cost)) * 100 : value;
	return `${Number(percent).toFixed(1)} %`;
};
const markupClass = (row) => {
	const value = markup(row);
	if (value == null || Number(row.cost) === 0) return "neutral";
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
			{ method: "POST" },
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
	if (!props.sourcePoint) return;
	emit("busy", true);
	try {
		preview.value = await call("raspechatka.api.catalog_pricing.preview_copy_prices", {
			business_point: props.businessPoint,
			source_point: props.sourcePoint,
			catalog_group: props.catalogGroup,
		});
		modal.value = "copy";
	} catch (error) {
		emit("error", error.message);
	} finally {
		emit("busy", false);
	}
}
async function previewCalculator() {
	emit("busy", true);
	try {
		preview.value = await call("raspechatka.api.catalog_pricing.preview_calculated_prices", {
			business_point: props.businessPoint,
			catalog_group: props.catalogGroup,
			spec: JSON.stringify(calculator),
		});
		modal.value = "calculator-preview";
	} catch (error) {
		emit("error", error.message);
	} finally {
		emit("busy", false);
	}
}
async function applyPreview() {
	if (applying.value || !preview.value) return;
	applying.value = true;
	emit("busy", true);
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
					? { source_point: props.sourcePoint }
					: { spec: JSON.stringify(calculator) }),
			},
			{ method: "POST" },
		);
		modal.value = "";
		emit("feedback", `Обновлено цен: ${result.updated}.`);
		emit("reload");
	} catch (error) {
		emit("error", error.message);
	} finally {
		applying.value = false;
		emit("busy", false);
	}
}

function openCalculator() {
	modal.value = "calculator";
}

defineExpose({ openCalculator, previewCopy });
</script>

<template>
	<div class="price-workspace">
		<div class="layer-table-wrap">
			<table class="layer-table">
				<thead>
					<tr>
						<th>Позиция</th>
						<th>Тип / группа</th>
						<th>Себестоимость</th>
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
						<td :title="row.cost_reason_message || ''">{{ money(row.cost) }}</td>
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
								markupLabel(row.rate, row.cost, markup(row))
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
			<div class="calculator-intro">
				<div>
					<strong>{{ pointLabel }}</strong>
					<span>{{ groupLabel }}</span>
				</div>
				<div class="calculator-count">
					<b>{{ rows.length }}</b
					><span>позиций</span>
				</div>
			</div>
			<p class="calculator-hint">
				Настройте правило массового изменения. Перед применением вы увидите все новые цены.
			</p>
			<section class="calculator-section">
				<h3>Правило расчёта</h3>
				<div class="calculator-grid">
					<label
						><span>Режим</span
						><select v-model="calculator.mode">
							<option value="change">Изменить базовую цену</option>
							<option value="markup">Установить наценку</option>
						</select></label
					>
					<label v-if="calculator.mode === 'change'"
						><span>От какой цены считать</span
						><select v-model="calculator.base">
							<option value="current">Текущая цена</option>
							<option value="cost">Себестоимость</option>
						</select></label
					>
					<label v-if="calculator.mode === 'change'"
						><span>Что сделать</span
						><select v-model="calculator.operation">
							<option value="add">Увеличить</option>
							<option value="subtract">Уменьшить</option>
						</select></label
					>
					<label v-if="calculator.mode === 'change'"
						><span>Единица изменения</span
						><select v-model="calculator.unit">
							<option value="percent">%</option>
							<option value="ruble">₽</option>
						</select></label
					>
					<label
						><span>{{ calculator.mode === "markup" ? "Наценка, %" : "Значение" }}</span
						><input v-model.number="calculator.value" type="number"
					/></label>
					<label
						><span>Шаг округления, ₽</span
						><input
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
						><span>Как округлять</span
						><select v-model="calculator.rounding_mode">
							<option value="nearest">Ближайшее</option>
							<option value="up">Вверх</option>
							<option value="down">Вниз</option>
						</select></label
					>
				</div>
			</section>
			<details class="conditions calculator-section">
				<summary>
					<span>Дополнительные ограничения</span><small>Необязательно</small>
				</summary>
				<div class="calculator-grid">
					<label
						><span>Минимальная цена, ₽</span
						><input v-model="calculator.min_price" type="number" min="0" /></label
					><label
						><span>Максимальная цена, ₽</span
						><input v-model="calculator.max_price" type="number" min="0" /></label
					><label
						><span>Менять только при наценке ниже, %</span
						><input v-model="calculator.only_markup_below" type="number" /></label
					><label class="check"
						><input
							v-model="calculator.skip_without_cost"
							type="checkbox"
							:true-value="1"
							:false-value="0"
						/><span>Пропускать позиции без себестоимости</span></label
					><label class="check"
						><input
							v-model="calculator.not_below_cost"
							type="checkbox"
							:true-value="1"
							:false-value="0"
						/><span>Не устанавливать цену ниже себестоимости</span></label
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
			:title="modal === 'copy' ? 'Копирование цен' : 'Предпросмотр новых цен'"
			wide
			@close="modal = ''"
		>
			<div class="preview-context">
				<div v-if="modal === 'copy'">
					<span>Из точки</span><strong>{{ sourceLabel }}</strong>
				</div>
				<span v-if="modal === 'copy'" class="preview-context__arrow">→</span>
				<div>
					<span>Точка назначения</span><strong>{{ pointLabel }}</strong>
				</div>
				<div>
					<span>Область</span><strong>{{ groupLabel }}</strong>
				</div>
			</div>
			<div class="preview-summary">
				<div class="preview-summary__primary">
					<b>{{ preview.summary.changed }}</b
					><span>Будет изменено</span>
				</div>
				<div>
					<b>{{ preview.summary.unchanged }}</b
					><span>Без изменений</span>
				</div>
				<div>
					<b>{{ preview.summary.skipped }}</b
					><span>Пропущено</span>
				</div>
			</div>
			<div class="preview-list">
				<div class="preview-head">
					<b>Позиция</b><b>Себестоимость</b><b>Текущая</b><b>Новая</b><b>Наценка была</b
					><b>Наценка станет</b><b>Результат</b>
				</div>
				<div v-for="row in preview.rows" :key="row.item">
					<span>{{ row.item_name }}</span
					><span :title="row.cost_reason_message || ''">{{ money(row.cost) }}</span
					><span>{{ money(row.current_rate) }}</span
					><span>{{ money(row.new_rate) }}</span
					><span>{{ markupLabel(row.current_rate, row.cost, row.current_markup) }}</span
					><span>{{ markupLabel(row.new_rate, row.cost, row.new_markup) }}</span
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
	gap: 7px;
	font-size: 13px;
	font-weight: 600;
	color: #34423a;
}
.calculator-grid .check {
	display: flex;
	align-items: center;
	gap: 9px;
	min-height: 42px;
	padding: 10px 12px;
	border: 1px solid var(--border);
	border-radius: 10px;
	background: #fff;
	font-weight: 500;
}
.calculator-grid input:not([type="checkbox"]),
.calculator-grid select {
	width: 100%;
	min-height: 42px;
}
.calculator-intro {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	padding: 16px 18px;
	border-radius: 14px;
	background: linear-gradient(135deg, var(--green-soft), #f7fbf3);
	border: 1px solid #d9ead1;
}
.calculator-intro > div:first-child {
	display: grid;
	gap: 3px;
}
.calculator-intro strong {
	font-size: 17px;
	color: var(--green-dark);
}
.calculator-intro span,
.calculator-hint {
	color: var(--muted);
}
.calculator-count {
	display: grid;
	justify-items: end;
}
.calculator-count b {
	font-size: 22px;
	line-height: 1;
	color: var(--green-dark);
}
.calculator-hint {
	margin: 12px 2px 18px;
	font-size: 13px;
}
.calculator-section {
	padding: 16px;
	border: 1px solid var(--border);
	border-radius: 14px;
	background: #fafbf9;
}
.calculator-section h3 {
	margin: 0 0 14px;
	font-size: 15px;
}
.conditions {
	margin-top: 14px;
}
.conditions summary {
	cursor: pointer;
	font-weight: 600;
	display: flex;
	justify-content: space-between;
	align-items: center;
}
.conditions summary small {
	color: var(--muted);
	font-weight: 500;
}
.conditions .calculator-grid {
	margin-top: 12px;
}
.preview-list {
	max-height: 48vh;
	overflow: auto;
	margin-top: 14px;
	border: 1px solid var(--border);
	border-radius: 12px;
}
.preview-list > div {
	display: grid;
	grid-template-columns: 2fr repeat(5, 1fr) 1.5fr;
	gap: 8px;
	min-width: 900px;
	padding: 8px;
	border-bottom: 1px solid var(--border);
}
.preview-head {
	position: sticky;
	top: 0;
	background: #fff;
}
.preview-context,
.preview-summary {
	display: flex;
	align-items: center;
	gap: 14px;
	padding: 14px 16px;
	border: 1px solid var(--border);
	border-radius: 14px;
	background: #fafbf9;
}
.preview-context > div,
.preview-summary > div {
	display: grid;
	gap: 3px;
}
.preview-context > div:last-child {
	margin-left: auto;
}
.preview-context span,
.preview-summary span {
	color: var(--muted);
	font-size: 12px;
}
.preview-context__arrow {
	font-size: 18px !important;
	color: var(--green-dark) !important;
}
.preview-summary {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	margin-top: 12px;
}
.preview-summary b {
	font-size: 20px;
}
.preview-summary__primary b {
	color: var(--green-dark);
}
@media (max-width: 700px) {
	.calculator-grid {
		grid-template-columns: 1fr;
	}
	.preview-context {
		align-items: flex-start;
		flex-direction: column;
	}
	.preview-context > div:last-child {
		margin-left: 0;
	}
	.preview-context__arrow {
		transform: rotate(90deg);
	}
}
</style>
