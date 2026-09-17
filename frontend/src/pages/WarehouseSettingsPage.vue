<script setup>
import { onMounted, reactive, ref } from "vue";
import { call, canAccess } from "../api";
import ListPageHeader from "../components/ListPageHeader.vue";

const policy = reactive({ analysis_days: 180, minimum_days: 30, target_days: 90 });
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const feedback = ref("");
const canAdmin = canAccess("page.warehouse.settings", "Admin");

async function load() {
	loading.value = true;
	error.value = "";
	try {
		Object.assign(
			policy,
			await call("raspechatka.api.warehouse_settings.get_warehouse_policy")
		);
	} catch (exception) {
		error.value = exception.message;
	} finally {
		loading.value = false;
	}
}

async function save() {
	if (saving.value) return;
	saving.value = true;
	error.value = "";
	feedback.value = "";
	try {
		Object.assign(
			policy,
			await call("raspechatka.api.warehouse_settings.save_warehouse_policy", policy, {
				method: "POST",
			})
		);
		feedback.value = "Политика запасов сохранена.";
	} catch (exception) {
		error.value = exception.message;
	} finally {
		saving.value = false;
	}
}

onMounted(load);
</script>

<template>
	<section class="page settings-page">
		<ListPageHeader title="Настройки склада" />
		<p v-if="error" class="form-error">{{ error }}</p>
		<p v-if="feedback" class="form-success">{{ feedback }}</p>
		<div class="settings-card">
			<h2>Политика запасов</h2>
			<p>Глобальные параметры сети для расчёта минимального и целевого остатка.</p>
			<div v-if="loading">Загрузка…</div>
			<div v-else class="settings-grid">
				<label
					>Период анализа продаж, дней<input
						v-model.number="policy.analysis_days"
						type="number"
						min="1"
						:disabled="!canAdmin"
				/></label>
				<label
					>Минимальный запас, дней продаж<input
						v-model.number="policy.minimum_days"
						type="number"
						min="1"
						:disabled="!canAdmin"
				/></label>
				<label
					>Целевой запас, дней продаж<input
						v-model.number="policy.target_days"
						type="number"
						:min="policy.minimum_days"
						:disabled="!canAdmin"
				/></label>
			</div>
			<button
				v-if="canAdmin && !loading"
				class="button button-primary"
				:disabled="
					saving ||
					policy.analysis_days <= 0 ||
					policy.minimum_days <= 0 ||
					policy.target_days < policy.minimum_days
				"
				@click="save"
			>
				{{ saving ? "Сохранение…" : "Сохранить" }}
			</button>
		</div>
	</section>
</template>

<style scoped>
.settings-card {
	max-width: 760px;
	padding: 20px;
	border: 1px solid var(--border);
	border-radius: 14px;
	background: var(--surface);
}
.settings-card h2 {
	margin-top: 0;
}
.settings-grid {
	display: grid;
	gap: 14px;
	margin: 20px 0;
}
.settings-grid label {
	display: grid;
	gap: 6px;
}
.settings-grid input {
	max-width: 260px;
}
</style>
