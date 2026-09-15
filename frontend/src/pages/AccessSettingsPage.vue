<script setup>
import { computed, onMounted, ref } from "vue";
import { call } from "../api";

const loading = ref(true);
const saving = ref(false);
const editingRole = ref("");
const editingRoleName = ref("");
const managingRole = ref(false);
const blockedUsers = ref([]);
const saved = ref(false);
const error = ref("");
const areas = ref([]);
const roles = ref([]);
const matrix = ref({});
const hasDraft = computed(() => roles.value.some((role) => role.is_new));

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

function createRole() {
	const currentDraft = roles.value.find((role) => role.is_new);
	if (currentDraft) {
		beginRoleEdit(currentDraft);
		return;
	}
	const role = {
		name: `__new_role_${Date.now()}`,
		label: "Новая роль",
		editable: true,
		deletable: true,
		is_new: true,
	};
	roles.value.push(role);
	matrix.value[role.name] = {};
	for (const area of areas.value) matrix.value[role.name][area.area] = "None";
	beginRoleEdit(role);
}

function beginRoleEdit(role) {
	editingRole.value = role.name;
	editingRoleName.value = role.label;
	blockedUsers.value = [];
}

function cancelRoleEdit(role = null) {
	if (role?.is_new) {
		roles.value = roles.value.filter((item) => item.name !== role.name);
		delete matrix.value[role.name];
	}
	editingRole.value = "";
	editingRoleName.value = "";
}

async function renameRole(role) {
	const roleName = editingRoleName.value.trim();
	if (!roleName || managingRole.value) return;
	managingRole.value = true;
	error.value = "";
	try {
		if (role.is_new) {
			await call(
				"raspechatka.access.create_work_role",
				{ role_name: roleName },
				{ method: "POST" }
			);
		} else {
			await call(
				"raspechatka.access.rename_work_role",
				{ role: role.name, role_name: roleName },
				{ method: "POST" }
			);
		}
		cancelRoleEdit();
		await load();
	} catch (renameError) {
		error.value = renameError.message;
	} finally {
		managingRole.value = false;
	}
}

async function deleteRole(role) {
	if (role.is_new) {
		cancelRoleEdit(role);
		return;
	}
	if (managingRole.value || !confirm(`Удалить роль «${role.label}»?`)) return;
	managingRole.value = true;
	error.value = "";
	blockedUsers.value = [];
	try {
		const result = await call(
			"raspechatka.access.delete_work_role",
			{ role: role.name },
			{ method: "POST" }
		);
		if (!result.deleted) {
			blockedUsers.value = result.users || [];
			error.value = "Удалить роль нельзя: она назначена пользователям.";
			return;
		}
		cancelRoleEdit();
		await load();
	} catch (deleteError) {
		error.value = deleteError.message;
	} finally {
		managingRole.value = false;
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
				<button
					class="button button-secondary"
					:disabled="loading || managingRole"
					@click="createRole"
				>
					＋ Создать роль
				</button>
				<button
					class="button button-primary"
					:disabled="saving || loading || hasDraft"
					@click="save"
				>
					{{ saving ? "Сохраняем…" : "Сохранить настройки" }}
				</button>
			</div>
		</div>

		<div v-if="error" class="form-error">{{ error }}</div>
		<ul v-if="blockedUsers.length" class="blocked-users">
			<li v-for="user in blockedUsers" :key="user.user || user.label">{{ user.label }}</li>
		</ul>
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
							<div v-if="editingRole === role.name" class="role-editor">
								<input
									v-model="editingRoleName"
									maxlength="140"
									:aria-label="`Новое название роли ${role.label}`"
									@keyup.enter="renameRole(role)"
									@keyup.esc="cancelRoleEdit(role)"
								/>
								<div class="role-actions">
									<button
										type="button"
										:title="'Сохранить название'"
										:disabled="managingRole || !editingRoleName.trim()"
										@click="renameRole(role)"
									>
										✓
									</button>
									<button
										type="button"
										title="Отменить"
										@click="cancelRoleEdit(role)"
									>
										×
									</button>
									<button
										type="button"
										class="danger"
										title="Удалить роль"
										:disabled="managingRole"
										@click="deleteRole(role)"
									>
										🗑
									</button>
								</div>
							</div>
							<div v-else class="role-heading">
								<span>{{ role.label }}</span>
								<button
									v-if="role.editable"
									type="button"
									:title="`Редактировать роль ${role.label}`"
									@click="beginRoleEdit(role)"
								>
									✎
								</button>
								<span v-else class="role-lock" title="Встроенная роль защищена"
									>🔒</span
								>
							</div>
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
.role-heading {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}
.role-heading button,
.role-actions button {
	width: 28px;
	height: 28px;
	padding: 0;
	border: 1px solid var(--line);
	border-radius: 5px;
	background: #fff;
	cursor: pointer;
}
.role-lock {
	font-size: 12px;
}
.role-editor {
	display: grid;
	gap: 6px;
}
.role-editor input {
	width: 100%;
	min-width: 0;
}
.role-actions {
	display: flex;
	gap: 5px;
}
.role-actions .danger {
	color: #a02d21;
}
.blocked-users {
	margin: -8px 0 14px;
	padding: 10px 14px 10px 30px;
	border: 1px solid #e6c7c2;
	background: #fff7f5;
	font-size: 11px;
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
