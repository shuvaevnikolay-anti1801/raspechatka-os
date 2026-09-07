<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { call } from "../api";
import AppModal from "../components/AppModal.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import ReferenceTable from "../components/ReferenceTable.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";

const rows = ref([]);
const loading = ref(true);
const error = ref("");
const detail = ref(null);
const saving = ref(false);
const formError = ref("");
const invitation = ref("");
const filters = ref({ search: "", active: "" });
const options = reactive({ organizations: [], entities: [], points: [], employees: [] });
const form = reactive({});

const columns = [
	{ key: "full_name", label: "ФИО", primary: true },
	{ key: "phone", label: "Телефон / логин" },
	{ key: "access_profile", label: "Профиль доступа" },
	{ key: "scope_type", label: "Область доступа" },
	{ key: "invitation_status", label: "Приглашение" },
	{ key: "active", label: "Статус" },
];
const filterFields = [
	{ key: "search", label: "Поиск", placeholder: "ФИО или номер телефона", wide: true },
	{ key: "active", label: "Статус", type: "select", allLabel: "Любой статус", options: [
		{ value: "1", label: "Активные" },
		{ value: "0", label: "Неактивные" },
	] },
];
const availableEntities = computed(() =>
	options.entities.filter((item) => !form.organization || item.organization === form.organization)
);
const availablePoints = computed(() =>
	options.points.filter((item) => !form.business_entity || item.business_entity === form.business_entity)
);

function reset(values = {}) {
	Object.keys(form).forEach((key) => delete form[key]);
	Object.assign(form, {
		active: 1,
		access_profile: "Cashier",
		scope_type: "Points",
		assigned_points: [],
		...values,
	});
	invitation.value = "";
	formError.value = "";
}
async function load() {
	loading.value = true;
	error.value = "";
	try {
		rows.value = await call("raspechatka.api.users.get_users", filters.value);
	} catch (exception) {
		error.value = exception.message;
	} finally {
		loading.value = false;
	}
}
async function loadOptions() {
	try {
		Object.assign(options, await call("raspechatka.api.users.get_user_options"));
	} catch (exception) {
		error.value = exception.message;
	}
}
function create() {
	reset();
	detail.value = {};
}
async function open(row) {
	try {
		const data = await call("raspechatka.api.users.get_user_profile", { name: row.name });
		detail.value = data;
		reset(JSON.parse(JSON.stringify(data)));
	} catch (exception) {
		error.value = exception.message;
	}
}
function hasPoint(name) {
	return (form.assigned_points || []).some((item) => item.business_point === name);
}
function togglePoint(point) {
	const list = form.assigned_points || (form.assigned_points = []);
	const index = list.findIndex((item) => item.business_point === point.name);
	if (index >= 0) list.splice(index, 1);
	else list.push({ business_point: point.name, is_default: list.length ? 0 : 1 });
}
async function save() {
	saving.value = true;
	formError.value = "";
	try {
		const result = await call("raspechatka.api.users.save_user_profile", {
			data: JSON.stringify(form),
		}, { method: "POST" });
		await Promise.all([load(), loadOptions()]);
		await open({ name: result.name });
	} catch (exception) {
		formError.value = exception.message;
	} finally {
		saving.value = false;
	}
}
async function setActive(active) {
	try {
		await call("raspechatka.api.users.set_user_active", {
			profile: form.name,
			active,
		}, { method: "POST" });
		detail.value = null;
		await load();
	} catch (exception) {
		formError.value = exception.message;
	}
}
async function generateInvitation() {
	formError.value = "";
	try {
		const result = await call("raspechatka.api.users.generate_invitation", {
			profile: form.name,
		}, { method: "POST" });
		invitation.value = result.message;
		form.invitation_status = "Generated";
		await load();
	} catch (exception) {
		formError.value = exception.message;
	}
}
async function copyInvitation() {
	await navigator.clipboard.writeText(invitation.value);
}
async function closeSessions() {
	if (!confirm("Завершить все активные сеансы этого пользователя?")) return;
	try {
		await call("raspechatka.api.users.disable_sessions", {
			profile: form.name,
		}, { method: "POST" });
	} catch (exception) {
		formError.value = exception.message;
	}
}

onMounted(() => Promise.all([load(), loadOptions()]));
</script>

<template>
	<section class="page reference-page">
		<ListPageHeader title="Пользователи">
			<template #actions>
				<button class="button button-primary" @click="create">＋ Добавить пользователя</button>
			</template>
		</ListPageHeader>
		<SmartFilterBar
			v-model="filters"
			:fields="filterFields"
			view-key="references.users"
			@apply="load"
			@reset="load"
		/>
		<ReferenceTable
			:rows="rows"
			:columns="columns"
			view-key="references.users"
			:loading="loading"
			:error="error"
			@open="open"
			@retry="load"
		/>
		<AppModal v-if="detail !== null" title="Пользователь" wide @close="detail = null">
			<form class="editor-form" @submit.prevent="save">
				<div class="form-section">
					<h3>Вход и профиль</h3>
					<div class="form-grid">
						<label>Фамилия<input v-model="form.last_name" /></label>
						<label>Имя<input v-model="form.first_name" required /></label>
						<label>Отчество<input v-model="form.middle_name" /></label>
						<label>Номер телефона — логин<input v-model="form.phone" type="tel" placeholder="+7 900 000-00-00" required /></label>
						<label>Профиль доступа
							<select v-model="form.access_profile" required>
								<option value="Network Admin">Администратор сети</option>
								<option value="Franchise Owner">Владелец франчайзи</option>
								<option value="Point Manager">Управляющий точками</option>
								<option value="Cashier">Кассир</option>
							</select>
						</label>
						<label>Область доступа
							<select v-model="form.scope_type" required>
								<option value="Network">Вся сеть</option>
								<option value="Partner">Партнёр</option>
								<option value="Business Entity">Юридическое лицо</option>
								<option value="Points">Выбранные точки</option>
							</select>
						</label>
						<label v-if="form.scope_type === 'Partner'">Партнёр
							<select v-model="form.organization" required>
								<option value="">Не выбран</option>
								<option v-for="item in options.organizations" :key="item.name" :value="item.name">{{ item.organization_name }}</option>
							</select>
						</label>
						<label v-if="form.scope_type === 'Business Entity' || form.scope_type === 'Points'">Юридическое лицо
							<select v-model="form.business_entity" :required="form.scope_type === 'Business Entity'">
								<option value="">Не выбрано</option>
								<option v-for="item in availableEntities" :key="item.name" :value="item.name">{{ item.short_name }}</option>
							</select>
						</label>
						<label>Связанный сотрудник
							<select v-model="form.linked_employee">
								<option value="">Не связан</option>
								<option v-for="item in options.employees" :key="item.name" :value="item.name">{{ item.employee_name }}</option>
							</select>
						</label>
						<label class="check-field"><input v-model="form.active" type="checkbox" :true-value="1" :false-value="0" /> Пользователь активен</label>
						<label class="span-3">Комментарий<textarea v-model="form.notes" rows="2"></textarea></label>
					</div>
				</div>
				<div v-if="form.scope_type === 'Points'" class="form-section">
					<h3>Доступные точки</h3>
					<div class="point-picker">
						<label v-for="point in availablePoints" :key="point.name">
							<input type="checkbox" :checked="hasPoint(point.name)" @change="togglePoint(point)" />
							{{ point.point_name }}
						</label>
					</div>
				</div>
				<div v-if="form.name" class="form-section">
					<h3>Приглашение и безопасность</h3>
					<div class="security-actions">
						<button type="button" class="button button-secondary" @click="generateInvitation">Создать ссылку для первого входа</button>
						<button type="button" class="button button-secondary" @click="closeSessions">Завершить сеансы</button>
					</div>
					<div v-if="invitation" class="invitation">
						<textarea :value="invitation" rows="6" readonly></textarea>
						<button type="button" class="button button-secondary" @click="copyInvitation">Копировать сообщение</button>
					</div>
				</div>
				<p v-if="formError" class="form-error">{{ formError }}</p>
			</form>
			<template #footer>
				<div v-if="form.name" class="danger-actions">
					<button class="text-button" @click="setActive(form.active ? 0 : 1)">{{ form.active ? "Отключить доступ" : "Восстановить доступ" }}</button>
				</div>
				<div class="footer-actions">
					<button class="button button-secondary" @click="detail = null">Закрыть</button>
					<button class="button button-primary" :disabled="saving" @click="save">{{ saving ? "Сохраняем…" : "Сохранить" }}</button>
				</div>
			</template>
		</AppModal>
	</section>
</template>

<style scoped>
.security-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.invitation { display: grid; gap: 10px; margin-top: 14px; }
.invitation textarea { width: 100%; resize: vertical; }
</style>
