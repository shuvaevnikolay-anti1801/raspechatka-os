<script setup>
import { computed, onMounted, ref } from "vue";
import { call } from "../api";

const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref("");
const areas = ref([]);
const roles = ref([]);
const matrix = ref({});

const groupedAreas = computed(() => {
	const groups = [];
	for (const area of areas.value) {
		let group = groups.find((item) => item.key === area.section_key);
		if (!group) {
			group = { key: area.section_key, label: area.section_label, areas: [] };
			groups.push(group);
		}
		group.areas.push(area);
	}
	return groups;
});

function isProtected(role, area) {
	return role.name === "Raspechatka Network Admin" && area.area === "page.references.access";
}

async function load() {
	loading.value = true;
	error.value = "";
	try {
		const result = await call("raspechatka.access.get_access_settings");
		areas.value = result.areas || [];
		roles.value = result.roles || [];
		const nextMatrix = {};
		for (const role of roles.value) {
			nextMatrix[role.name] = {};
			for (const area of areas.value) nextMatrix[role.name][area.area] = "None";
		}
		for (const rule of result.rules || []) {
			if (nextMatrix[rule.role]) nextMatrix[rule.role][rule.access_area] = rule.access_level;
		}
		matrix.value = nextMatrix;
	} catch (loadError) {
		error.value = loadError.message;
	} finally {
		loading.value = false;
	}
}

async function save() {
	saving.value = true;
	saved.value = false;
	error.value = "";
	try {
		const rules = [];
		for (const role of roles.value) {
			for (const area of areas.value) {
				rules.push({
					role: role.name,
					access_area: area.area,
					access_level: matrix.value[role.name][area.area],
				});
			}
		}
		await call(
			"raspechatka.access.save_access_settings",
			{ rules: JSON.stringify(rules) },
			{ method: "POST" }
		);
		saved.value = true;
		window.setTimeout(() => (saved.value = false), 2500);
	} catch (saveError) {
		error.value = saveError.message;
	} finally {
		saving.value = false;
	}
}

onMounted(load);
</script>

<template>
	<section class="page access-page">
		<div class="page-heading">
			<div>
				<div class="eyebrow">НАСТРОЙКИ</div>
				<h1>Права доступа</h1>
				<p>Строки — страницы системы, столбцы — действующие роли.</p>
			</div>
			<div class="heading-actions">
				<span v-if="saved" class="save-state">Сохранено</span>
				<button class="button button-primary" :disabled="saving || loading" @click="save">
					{{ saving ? "Сохраняем…" : "Сохранить настройки" }}
				</button>
			</div>
		</div>

		<div v-if="error" class="form-error">{{ error }}</div>
		<div v-if="loading" class="table-message"><span class="loader"></span></div>
		<div v-else-if="!roles.length" class="empty-state">
			<b>Нет доступных ролей</b>
			<span>Создайте рабочую роль — она автоматически появится в этой таблице.</span>
		</div>
		<div v-else class="access-matrix table-shell">
			<table>
				<thead>
					<tr>
						<th class="page-column">Раздел / страница</th>
						<th v-for="role in roles" :key="role.name" class="role-column">
							<span>{{ role.label }}</span>
						</th>
					</tr>
				</thead>
				<tbody v-for="section in groupedAreas" :key="section.key">
					<tr class="section-row">
						<th :colspan="roles.length + 1">{{ section.label }}</th>
					</tr>
					<tr v-for="area in section.areas" :key="area.area">
						<td class="page-name">
							<b>{{ area.label }}</b>
							<small>{{ area.route }}</small>
						</td>
						<td v-for="role in roles" :key="role.name">
							<select
								v-model="matrix[role.name][area.area]"
								:disabled="isProtected(role, area)"
								:aria-label="`${area.label}: ${role.label}`"
							>
								<option value="None">Не видно</option>
								<option value="View">Чтение</option>
								<option value="Edit">Запись</option>
								<option value="Admin">Администратор</option>
							</select>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
		<p class="settings-note">
			Новые рабочие роли и страницы меню добавляются в матрицу автоматически. Ограничения по
			партнёрам, юридическим лицам и точкам применяются дополнительно.
		</p>
	</section>
</template>

<style scoped>
.heading-actions {
	display: flex;
	align-items: center;
	gap: 12px;
}
.save-state {
	color: #668600;
	font-size: 11px;
	font-weight: 700;
}
.access-matrix {
	max-width: 100%;
	overflow: auto;
	border: 1px solid var(--line);
}
.access-matrix table {
	width: max-content;
	min-width: 100%;
	border-collapse: separate;
	border-spacing: 0;
}
.access-matrix thead th {
	position: sticky;
	z-index: 3;
	top: 0;
	height: 58px;
	border-bottom: 1px solid var(--line-dark);
	background: #f6f7f4;
	font-size: 10px;
	text-align: left;
}
.page-column,
.page-name {
	position: sticky;
	z-index: 2;
	left: 0;
	width: 260px;
	min-width: 260px;
	background: #fff;
}
.access-matrix thead .page-column {
	z-index: 4;
	background: #f6f7f4;
}
.role-column {
	width: 168px;
	min-width: 168px;
}
.role-column span {
	display: block;
	max-width: 150px;
	line-height: 1.3;
}
.section-row th {
	position: sticky;
	z-index: 1;
	left: 0;
	padding: 9px 14px;
	border-bottom: 1px solid #dde1d8;
	background: #edf2df;
	color: #4f6800;
	font-size: 10px;
	letter-spacing: 0.04em;
	text-align: left;
	text-transform: uppercase;
}
.access-matrix td,
.access-matrix th {
	padding: 9px 12px;
	border-right: 1px solid #e8eae5;
	border-bottom: 1px solid #e8eae5;
}
.access-matrix tr:last-child td {
	border-bottom: 0;
}
.page-name b,
.page-name small {
	display: block;
}
.page-name b {
	font-size: 12px;
}
.page-name small {
	margin-top: 3px;
	color: #8a8f86;
	font-size: 9px;
}
.access-matrix select {
	width: 145px;
	min-height: 36px;
	padding: 0 30px 0 10px;
	font-size: 10px;
}
.access-matrix select:disabled {
	opacity: 1;
	background: #edf3dc;
	color: #526d00;
}
.empty-state {
	display: grid;
	min-height: 220px;
	place-content: center;
	gap: 7px;
	border: 1px solid var(--line);
	background: #fff;
	text-align: center;
}
.empty-state span {
	color: #777d74;
	font-size: 11px;
}
@media (max-width: 760px) {
	.page-column,
	.page-name {
		width: 190px;
		min-width: 190px;
	}
}
</style>
