<script setup>
import { computed, ref } from "vue";
import { call } from "../api";
import AppModal from "./AppModal.vue";

const props = defineProps({
	rows: { type: Array, default: () => [] },
	points: { type: Array, default: () => [] },
	businessPoint: { type: String, default: "" },
	catalogGroup: { type: String, default: "" },
	groupLabel: { type: String, default: "Все позиции" },
	canEdit: { type: Boolean, default: false },
	loading: { type: Boolean, default: false },
	sourcePoint: { type: String, default: "" },
});
const emit = defineEmits(["reload", "error", "feedback", "dirty", "busy"]);
const saving = ref(new Set());
const dirtyRows = ref(new Set());
const preview = ref(null);
const modal = ref("");
const calculating = ref(false);
const pointLabel = computed(
	() =>
		props.points.find((point) => point.name === props.businessPoint)?.point_name ||
		props.businessPoint,
);
const sourceLabel = computed(
	() =>
		props.points.find((point) => point.name === props.sourcePoint)?.point_name ||
		props.sourcePoint,
);

function changed(row) {
	row.dirty = true;
	dirtyRows.value.add(row.name);
	emit("dirty", true);
}

async function save(row) {
	if (saving.value.has(row.name)) return;
	saving.value.add(row.name);
	emit("error", "");
	try {
		await call(
			"raspechatka.api.catalog_layers.save_minimum_stock",
			{
				business_point: props.businessPoint,
				item: row.name,
				minimum_stock: row.minimum_stock,
				target_stock: row.target_stock,
			},
			{ method: "POST" },
		);
		emit("feedback", `Норматив для «${row.item_name}» сохранён.`);
		dirtyRows.value.delete(row.name);
		emit("dirty", dirtyRows.value.size > 0);
		emit("reload");
	} catch (error) {
		emit("error", error.message);
	} finally {
		saving.value.delete(row.name);
	}
}

async function copyNorms() {
	if (!props.sourcePoint) return;
	calculating.value = true;
	emit("busy", true);
	try {
		const result = await call(
			"raspechatka.api.catalog_layers.copy_stock_norms",
			{
				business_point: props.businessPoint,
				source_point: props.sourcePoint,
				catalog_group: props.catalogGroup,
			},
			{ method: "POST" },
		);
		modal.value = "";
		emit("feedback", `Скопировано ${result.copied}; пропущено ${result.skipped}.`);
		dirtyRows.value.clear();
		emit("dirty", false);
		emit("reload");
	} catch (error) {
		emit("error", error.message);
	} finally {
		calculating.value = false;
		emit("busy", false);
	}
}

function previewCopy() {
	if (!props.sourcePoint) return;
	modal.value = "copy";
}

async function calculate() {
	calculating.value = true;
	emit("busy", true);
	try {
		preview.value = await call("raspechatka.api.catalog_layers.preview_stock_norms", {
			business_point: props.businessPoint,
			catalog_group: props.catalogGroup,
		});
	} catch (error) {
		emit("error", error.message);
	} finally {
		calculating.value = false;
		emit("busy", false);
	}
}

function openCalculator() {
	preview.value = null;
	modal.value = "calculator";
}

async function applyPreview() {
	const count = preview.value?.counts?.change || 0;
	if (!count) return;
	calculating.value = true;
	emit("busy", true);
	try {
		const result = await call(
			"raspechatka.api.catalog_layers.apply_stock_norms",
			{
				business_point: props.businessPoint,
				catalog_group: props.catalogGroup,
				preview_token: preview.value.preview_token,
			},
			{ method: "POST" },
		);
		preview.value = null;
		modal.value = "";
		emit("feedback", `Применено ${result.applied}; пропущено ${result.skipped}.`);
		dirtyRows.value.clear();
		emit("dirty", false);
		emit("reload");
	} catch (error) {
		emit("error", error.message);
	} finally {
		calculating.value = false;
		emit("busy", false);
	}
}

defineExpose({ openCalculator, previewCopy });
</script>

<template>
	<div class="norms-workspace">
		<table class="layer-table">
			<thead>
				<tr>
					<th>Позиция</th>
					<th>Тип / группа</th>
					<th>Минимальный остаток</th>
					<th>Целевой остаток</th>
					<th>Сохранить</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="row in rows" :key="row.name">
					<td>
						<strong>{{ row.item_name }}</strong
						><small>{{ row.item_code || row.name }}</small>
					</td>
					<td>
						{{ row.item_type }}<small>{{ row.catalog_group || "Без группы" }}</small>
					</td>
					<td>
						<input
							v-model.number="row.minimum_stock"
							type="number"
							min="0"
							step="any"
							:disabled="!canEdit || saving.has(row.name)"
							@input="changed(row)"
						/>
					</td>
					<td>
						<input
							v-model.number="row.target_stock"
							type="number"
							min="0"
							step="any"
							:disabled="!canEdit || saving.has(row.name)"
							@input="changed(row)"
						/>
					</td>
					<td>
						<button
							v-if="canEdit"
							class="button button-primary"
							:disabled="
								saving.has(row.name) || row.target_stock < row.minimum_stock
							"
							@click="save(row)"
						>
							Сохранить
						</button>
					</td>
				</tr>
				<tr v-if="!loading && !rows.length">
					<td colspan="5">В выбранной группе нет продаваемых складских товаров.</td>
				</tr>
			</tbody>
		</table>
		<AppModal v-if="modal === 'copy'" title="Копирование нормативов" @close="modal = ''">
			<div class="operation-context">
				<span>Из точки</span><strong>{{ sourceLabel }}</strong>
				<span class="operation-context__arrow">→</span>
				<span>В точку</span><strong>{{ pointLabel }}</strong>
			</div>
			<div class="operation-scope">
				<div>
					<span>Область</span><strong>{{ groupLabel }}</strong>
				</div>
				<div>
					<span>Позиций назначения</span><strong>{{ rows.length }}</strong>
				</div>
			</div>
			<p class="operation-note">
				Для совпадающих позиций нормативы точки назначения будут заменены значениями из
				выбранной точки. Остальные позиции будут пропущены.
			</p>
			<template #footer>
				<button
					class="button button-secondary"
					:disabled="calculating"
					@click="modal = ''"
				>
					Отмена
				</button>
				<button class="button button-primary" :disabled="calculating" @click="copyNorms">
					{{ calculating ? "Копируем…" : "Копировать нормативы" }}
				</button>
			</template>
		</AppModal>
		<AppModal v-if="modal === 'calculator'" title="Расчёт нормативов" wide @close="modal = ''">
			<div class="operation-context operation-context--compact">
				<div>
					<span>Точка продаж</span><strong>{{ pointLabel }}</strong>
				</div>
				<div>
					<span>Область расчёта</span><strong>{{ groupLabel }}</strong>
				</div>
				<div>
					<span>Позиций</span><strong>{{ rows.length }}</strong>
				</div>
			</div>
			<p v-if="!preview" class="operation-note">
				Система рассчитает минимальный и целевой остаток по истории продаж. Перед
				применением вы увидите результат по каждой позиции.
			</p>
			<template v-else>
				<div class="policy-summary">
					<span
						>Анализ: <b>{{ preview.policy.analysis_days }} дней</b></span
					>
					<span
						>Минимум: <b>{{ preview.policy.minimum_days }} дней</b></span
					>
					<span
						>Цель: <b>{{ preview.policy.target_days }} дней</b></span
					>
				</div>
				<div class="result-summary">
					<div class="result-summary__primary">
						<b>{{ preview.counts.change }}</b
						><span>Будет изменено</span>
					</div>
					<div>
						<b>{{ preview.counts.unchanged }}</b
						><span>Без изменений</span>
					</div>
					<div>
						<b>{{ preview.counts.insufficient }}</b
						><span>Недостаточно данных</span>
					</div>
					<div>
						<b>{{ preview.counts.skipped || 0 }}</b
						><span>Пропущено</span>
					</div>
				</div>
				<div class="preview-table">
					<table class="layer-table">
						<thead>
							<tr>
								<th>Позиция</th>
								<th>Продано нетто</th>
								<th>Дней</th>
								<th>Среднее</th>
								<th>Мин. сейчас / расчёт</th>
								<th>Цель сейчас / расчёт</th>
								<th>Статус</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="row in preview.rows" :key="row.name">
								<td>{{ row.item_name }}</td>
								<td>{{ row.net_sold_qty }}</td>
								<td>
									{{ row.history_days
									}}<small v-if="row.short_history">Короткая история</small>
								</td>
								<td>{{ Number(row.average_daily_sales).toFixed(3) }}</td>
								<td>
									{{ row.minimum_stock }} / {{ row.calculated_minimum ?? "—" }}
								</td>
								<td>
									{{ row.target_stock }} / {{ row.calculated_target ?? "—" }}
								</td>
								<td>
									<span
										class="status-badge"
										:class="`status-badge--${row.status}`"
										>{{
											row.status === "change"
												? "Будет изменено"
												: row.status === "unchanged"
													? "Без изменений"
													: row.status === "skipped"
														? "Пропущено"
														: "Недостаточно данных"
										}}</span
									>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</template>
			<template #footer>
				<button
					class="button button-secondary"
					:disabled="calculating"
					@click="modal = ''"
				>
					Отмена
				</button>
				<button
					v-if="!preview"
					class="button button-primary"
					:disabled="calculating"
					@click="calculate"
				>
					{{ calculating ? "Расчёт…" : "Рассчитать нормативы" }}
				</button>
				<button
					v-else
					class="button button-primary"
					:disabled="!preview.counts.change || calculating"
					@click="applyPreview"
				>
					{{ calculating ? "Применяем…" : "Применить рассчитанные нормативы" }}
				</button>
			</template>
		</AppModal>
	</div>
</template>

<style scoped>
.operation-context,
.operation-scope,
.policy-summary,
.result-summary {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 14px 16px;
	border: 1px solid var(--border);
	border-radius: 14px;
	background: #fafbf9;
}
.operation-context > span,
.operation-context > div span,
.operation-scope span,
.result-summary span {
	color: var(--muted);
	font-size: 12px;
}
.operation-context__arrow {
	font-size: 18px !important;
	color: var(--green-dark) !important;
}
.operation-context--compact {
	justify-content: space-between;
}
.operation-context--compact > div,
.operation-scope > div,
.result-summary > div {
	display: grid;
	gap: 3px;
}
.operation-scope {
	margin-top: 12px;
	justify-content: space-between;
}
.operation-note {
	margin: 14px 2px 0;
	color: var(--muted);
	font-size: 13px;
	line-height: 1.5;
}
.policy-summary {
	margin-top: 14px;
	justify-content: flex-start;
	color: var(--muted);
	font-size: 13px;
}
.result-summary {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	margin-top: 12px;
}
.result-summary b {
	font-size: 20px;
}
.result-summary__primary b {
	color: var(--green-dark);
}
.preview-table {
	max-height: 48vh;
	margin-top: 14px;
	overflow: auto;
	border: 1px solid var(--border);
	border-radius: 12px;
}
.preview-table thead {
	position: sticky;
	top: 0;
	z-index: 1;
}
.status-badge {
	display: inline-block;
	padding: 4px 8px;
	border-radius: 999px;
	background: #f1f3ef;
	color: var(--muted);
	font-size: 12px;
}
.status-badge--change {
	background: var(--green-soft);
	color: var(--green-dark);
}
.layer-table td small {
	display: block;
	color: var(--muted);
}
@media (max-width: 700px) {
	.operation-context,
	.operation-context--compact,
	.operation-scope,
	.policy-summary {
		align-items: flex-start;
		flex-direction: column;
	}
	.operation-context__arrow {
		transform: rotate(90deg);
	}
	.result-summary {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
}
</style>
