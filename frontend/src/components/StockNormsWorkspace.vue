<script setup>
import { computed, ref } from "vue";
import { call } from "../api";

const props = defineProps({
	rows: { type: Array, default: () => [] },
	points: { type: Array, default: () => [] },
	businessPoint: { type: String, default: "" },
	catalogGroup: { type: String, default: "" },
	groupLabel: { type: String, default: "Все позиции" },
	canEdit: { type: Boolean, default: false },
	loading: { type: Boolean, default: false },
});
const emit = defineEmits(["reload", "error", "feedback", "dirty"]);
const saving = ref(new Set());
const dirtyRows = ref(new Set());
const sourcePoint = ref("");
const preview = ref(null);
const modalOpen = ref(false);
const calculating = ref(false);
const sourcePoints = computed(() => props.points.filter((point) => point.name !== props.businessPoint));

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
		await call("raspechatka.api.catalog_layers.save_minimum_stock", {
			business_point: props.businessPoint,
			item: row.name,
			minimum_stock: row.minimum_stock,
			target_stock: row.target_stock,
		}, { method: "POST" });
		emit("feedback", `Норматив для «${row.item_name}» сохранён.`);
		dirtyRows.value.delete(row.name);
		emit("dirty", dirtyRows.value.size > 0);
		emit("reload");
	} catch (error) { emit("error", error.message); }
	finally { saving.value.delete(row.name); }
}

async function copyNorms() {
	if (!sourcePoint.value) return;
	const source = props.points.find((point) => point.name === sourcePoint.value)?.point_name;
	const target = props.points.find((point) => point.name === props.businessPoint)?.point_name;
	if (!window.confirm(`Скопировать нормативы: ${source} → ${target}; область: ${props.groupLabel}; позиций назначения: ${props.rows.length}?`)) return;
	try {
		const result = await call("raspechatka.api.catalog_layers.copy_stock_norms", {
			business_point: props.businessPoint,
			source_point: sourcePoint.value,
			catalog_group: props.catalogGroup,
		}, { method: "POST" });
		emit("feedback", `Скопировано ${result.copied}; пропущено ${result.skipped}.`);
		dirtyRows.value.clear();
		emit("dirty", false);
		emit("reload");
	} catch (error) { emit("error", error.message); }
}

async function calculate() {
	calculating.value = true;
	try {
		preview.value = await call("raspechatka.api.catalog_layers.preview_stock_norms", {
			business_point: props.businessPoint,
			catalog_group: props.catalogGroup,
		});
	} catch (error) { emit("error", error.message); }
	finally { calculating.value = false; }
}

function openCalculator() {
	preview.value = null;
	modalOpen.value = true;
}

async function applyPreview() {
	const count = preview.value?.counts?.change || 0;
	if (!count || !window.confirm(`Применить рассчитанные нормативы для ${count} позиций?`)) return;
	calculating.value = true;
	try {
		const result = await call("raspechatka.api.catalog_layers.apply_stock_norms", {
			business_point: props.businessPoint,
			catalog_group: props.catalogGroup,
			preview_token: preview.value.preview_token,
		}, { method: "POST" });
		preview.value = null;
		modalOpen.value = false;
		emit("feedback", `Применено ${result.applied}; пропущено ${result.skipped}.`);
		dirtyRows.value.clear();
		emit("dirty", false);
		emit("reload");
	} catch (error) { emit("error", error.message); }
	finally { calculating.value = false; }
}
</script>

<template>
	<div class="norms-workspace">
		<div v-if="canEdit" class="norms-actions">
			<select v-model="sourcePoint"><option value="">Скопировать нормативы из…</option><option v-for="point in sourcePoints" :key="point.name" :value="point.name">{{ point.point_name }}</option></select>
			<button class="button button-secondary" :disabled="!sourcePoint" @click="copyNorms">Скопировать</button>
			<button class="button button-primary" :disabled="!rows.length || calculating" @click="openCalculator">Рассчитать нормативы</button>
		</div>
		<table class="layer-table">
			<thead><tr><th>Позиция</th><th>Тип / группа</th><th>Минимальный остаток</th><th>Целевой остаток</th><th>Сохранить</th></tr></thead>
			<tbody>
				<tr v-for="row in rows" :key="row.name">
					<td><strong>{{ row.item_name }}</strong><small>{{ row.item_code || row.name }}</small></td>
					<td>{{ row.item_type }}<small>{{ row.catalog_group || "Без группы" }}</small></td>
					<td><input v-model.number="row.minimum_stock" type="number" min="0" step="any" :disabled="!canEdit || saving.has(row.name)" @input="changed(row)" /></td>
					<td><input v-model.number="row.target_stock" type="number" min="0" step="any" :disabled="!canEdit || saving.has(row.name)" @input="changed(row)" /></td>
					<td><button v-if="canEdit" class="button button-primary" :disabled="saving.has(row.name) || row.target_stock < row.minimum_stock" @click="save(row)">Сохранить</button></td>
				</tr>
				<tr v-if="!loading && !rows.length"><td colspan="5">В выбранной группе нет продаваемых складских товаров.</td></tr>
			</tbody>
		</table>
		<div v-if="modalOpen" class="norm-modal">
			<div class="norm-dialog">
				<div class="norm-dialog__head"><h2>Расчёт нормативов</h2><button @click="modalOpen = false">×</button></div>
				<p>{{ groupLabel }} · {{ rows.length }} позиций</p>
				<button v-if="!preview" class="button button-primary" :disabled="calculating" @click="calculate">{{ calculating ? "Расчёт…" : "Рассчитать" }}</button>
				<template v-else>
					<p>Анализ {{ preview.policy.analysis_days }} дней · минимум {{ preview.policy.minimum_days }} · цель {{ preview.policy.target_days }}</p>
					<p>Будет изменено: {{ preview.counts.change }} · Без изменений: {{ preview.counts.unchanged }} · Недостаточно данных: {{ preview.counts.insufficient }} · Пропущено: {{ preview.counts.skipped || 0 }}</p>
					<div class="preview-table"><table class="layer-table"><thead><tr><th>Позиция</th><th>Продано нетто</th><th>Дней</th><th>Среднее</th><th>Мин. сейчас / расчёт</th><th>Цель сейчас / расчёт</th><th>Статус</th></tr></thead><tbody><tr v-for="row in preview.rows" :key="row.name"><td>{{ row.item_name }}</td><td>{{ row.net_sold_qty }}</td><td>{{ row.history_days }}<small v-if="row.short_history">Короткая история</small></td><td>{{ Number(row.average_daily_sales).toFixed(3) }}</td><td>{{ row.minimum_stock }} / {{ row.calculated_minimum ?? "—" }}</td><td>{{ row.target_stock }} / {{ row.calculated_target ?? "—" }}</td><td>{{ row.status === "change" ? "Будет изменено" : row.status === "unchanged" ? "Без изменений" : row.status === "skipped" ? "Пропущено" : "Недостаточно данных" }}</td></tr></tbody></table></div>
				</template>
				<div class="norm-dialog__actions"><button class="button button-secondary" @click="modalOpen = false">Закрыть</button><button v-if="preview" class="button button-primary" :disabled="!preview.counts.change || calculating" @click="applyPreview">Применить рассчитанные нормативы</button></div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.norms-actions{display:flex;gap:8px;padding:12px;border-bottom:1px solid var(--border);flex-wrap:wrap}.norms-actions select{min-width:240px}.norm-modal{position:fixed;inset:0;z-index:100;background:#0008;display:grid;place-items:center;padding:24px}.norm-dialog{background:#fff;border-radius:16px;padding:18px;max-width:1200px;width:100%;max-height:90vh;overflow:auto}.norm-dialog__head,.norm-dialog__actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.norm-dialog__head button{border:0;background:none;font-size:24px}.norm-dialog__actions{justify-content:flex-end;margin-top:16px}.preview-table{overflow:auto}.layer-table td small{display:block;color:var(--muted)}
</style>
