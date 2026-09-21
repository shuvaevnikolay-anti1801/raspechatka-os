<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { call } from "../api";
import AppModal from "../components/AppModal.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import ReferenceTable from "../components/ReferenceTable.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";
import { mergeEntityFields } from "../entityListSchema";
import { createLatestRequestGate } from "../listLoading";

const listRequests = createLatestRequestGate();
const rows = ref([]);
const loading = ref(true);
const error = ref("");
const detail = ref(null);
const saving = ref(false);
const formError = ref("");
const invitation = ref("");
const diagnostics = ref(null);
const diagnosticsError = ref("");
const filters = ref({ search: "", active: "" });
const options = reactive({
	organizations: [],
	entities: [],
	points: [],
	employees: [],
	access_roles: [],
	system_timezone: "",
	timezones: [],
});
const form = reactive({});

const columns = computed(() => [
	{ key: "full_name", label: "ФИО", primary: true },
	{ key: "phone", label: "Телефон / логин" },
	{
		key: "access_profile",
		label: "Профиль доступа",
		type: "select",
		displayKey: "access_profile_label",
		options: options.access_roles.map((role) => ({ value: role.name, label: role.label })),
	},
	{
		key: "scope_type",
		label: "Область доступа",
		type: "select",
		options: [
			{ value: "Network", label: "Вся сеть" },
			{ value: "Partner", label: "Партнёр" },
			{ value: "Business Entity", label: "Юридическое лицо" },
			{ value: "Points", label: "Выбранные точки" },
		],
	},
	{
		key: "invitation_status",
		label: "Приглашение",
		type: "select",
		options: [
			{ value: "Not Generated", label: "Не создано" },
			{ value: "Generated", label: "Приглашение создано" },
			{ value: "Activated", label: "Пользователь активирован" },
		],
	},
	{ key: "active", label: "Статус" },
]);
const filterFields = [
	{ key: "search", label: "Поиск", placeholder: "ФИО или номер телефона", wide: true },
	{
		key: "active",
		label: "Статус",
		type: "select",
		allLabel: "Любой статус",
		options: [
			{ value: "1", label: "Активные" },
			{ value: "0", label: "Неактивные" },
		],
	},
];
const entityFields = computed(() => mergeEntityFields(filterFields, columns.value));
const availableEntities = computed(() =>
	options.entities.filter((item) => form.organization && item.organization === form.organization)
);
const availablePoints = computed(() =>
	options.points.filter(
		(item) => form.business_entity && item.business_entity === form.business_entity
	)
);

watch(
	() => form.organization,
	() => {
		if (!availableEntities.value.some((item) => item.name === form.business_entity)) {
			form.business_entity = "";
			form.assigned_points = [];
		}
	}
);
watch(
	() => form.business_entity,
	() => {
		const allowed = new Set(availablePoints.value.map((item) => item.name));
		form.assigned_points = (form.assigned_points || []).filter((row) =>
			allowed.has(row.business_point)
		);
	}
);
watch(
	() => form.scope_type,
	(scopeType) => {
		if (scopeType === "Network") {
			form.organization = "";
			form.business_entity = "";
			form.assigned_points = [];
		} else if (scopeType === "Partner") {
			form.business_entity = "";
			form.assigned_points = [];
		} else if (scopeType === "Business Entity") {
			form.assigned_points = [];
		}
	}
);

function reset(values = {}) {
	Object.keys(form).forEach((key) => delete form[key]);
	Object.assign(form, {
		active: 1,
		access_profile:
			options.access_roles.find((role) => role.name === "Raspechatka Cashier")?.name ||
			options.access_roles[0]?.name ||
			"",
		scope_type: "Points",
		assigned_points: [],
		...values,
	});
	invitation.value = "";
	formError.value = "";
}
async function load() {
	const requestId = listRequests.begin();
	loading.value = true;
	error.value = "";
	try {
		const result = await call("raspechatka.api.users.get_users", filters.value);
		if (!listRequests.isCurrent(requestId)) return;
		rows.value = result;
	} catch (exception) {
		if (listRequests.isCurrent(requestId)) error.value = exception.message;
	} finally {
		if (listRequests.isCurrent(requestId)) loading.value = false;
	}
}
async function loadOptions() {
	try {
		Object.assign(options, await call("raspechatka.api.users.get_user_options"));
	} catch (exception) {
		error.value = exception.message;
	}
}
async function loadDiagnostics() {
	try {
		diagnostics.value = await call("raspechatka.api.time.get_time_diagnostics");
	} catch (exception) {
		diagnosticsError.value = exception.message;
	}
}
function create() {
	reset({ time_zone: "" });
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
		const result = await call(
			"raspechatka.api.users.save_user_profile",
			{
				data: JSON.stringify(form),
			},
			{ method: "POST" }
		);
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
		await call(
			"raspechatka.api.users.set_user_active",
			{
				profile: form.name,
				active,
			},
			{ method: "POST" }
		);
		detail.value = null;
		await load();
	} catch (exception) {
		formError.value = exception.message;
	}
}
async function generateInvitation() {
	formError.value = "";
	try {
		const result = await call(
			"raspechatka.api.users.generate_invitation",
			{
				profile: form.name,
			},
			{ method: "POST" }
		);
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
		await call(
			"raspechatka.api.users.disable_sessions",
			{
				profile: form.name,
			},
			{ method: "POST" }
		);
	} catch (exception) {
		formError.value = exception.message;
	}
}

onMounted(() => {
	loadOptions();
	loadDiagnostics();
});
</script>

<template>
	<section class="page reference-page">
		<ListPageHeader title="Пользователи">
			<template #actions>
				<button class="button button-primary" @click="create">
					＋ Добавить пользователя
				</button>
			</template>
		</ListPageHeader>
		<section v-if="diagnostics || diagnosticsError" class="time-diagnostics">
			<div class="time-diagnostics-header">
				<h3>Время системы</h3>
				<span v-if="diagnosticsError" class="form-error">{{ diagnosticsError }}</span>
			</div>
			<div v-if="diagnostics" class="time-diagnostics-grid">
				<div>
					<span class="diagnostic-label">Сайт</span>
					<strong>{{ diagnostics.effective_site_timezone || "Не определён" }}</strong>
					<small>Настроен: {{ diagnostics.configured_site_timezone || "не задан" }}</small>
				</div>
				<div>
					<span class="diagnostic-label">Текущий пользователь</span>
					<strong>{{ diagnostics.current_user.effective_timezone || "Не определён" }}</strong>
					<small>Настроен: {{ diagnostics.current_user.configured_timezone || "системный fallback" }}</small>
				</div>
				<div>
					<span class="diagnostic-label">Сейчас</span>
					<strong>{{ diagnostics.now.user || diagnostics.now.site || diagnostics.now.utc }}</strong>
					<small>UTC: {{ diagnostics.now.utc }}</small>
				</div>
			</div>
			<div v-if="diagnostics?.points?.length" class="diagnostic-points">
				<span class="diagnostic-label">Активные точки</span>
				<span v-for="point in diagnostics.points" :key="point.name" class="diagnostic-point">
					{{ point.label }} — {{ point.timezone || "не задан" }}
				</span>
			</div>
			<ul v-if="diagnostics?.warnings?.length" class="diagnostic-warnings">
				<li v-for="warning in diagnostics.warnings" :key="warning.code + (warning.subject || '')">
					{{ warning.message }}
				</li>
			</ul>
		</section>
		<SmartFilterBar
			v-model="filters"
			:entity-fields="entityFields"
			view-key="references.users"
			@apply="load"
			@reset="load"
			@ready="load"
		/>
		<ReferenceTable
			:rows="rows"
			:entity-fields="entityFields"
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
						<label
							>Номер телефона — логин<input
								v-model="form.phone"
								type="tel"
								placeholder="+7 900 000-00-00"
								required
						/></label>
						<label
							>Рабочая роль
							<select v-model="form.access_profile" required>
								<option
									v-for="role in options.access_roles"
									:key="role.name"
									:value="role.name"
								>
									{{ role.label }}
								</option>
							</select>
						</label>
						<label
							>Область доступа
							<select v-model="form.scope_type" required>
								<option value="Network">Вся сеть</option>
								<option value="Partner">Партнёр</option>
								<option value="Business Entity">Юридическое лицо</option>
								<option value="Points">Выбранные точки</option>
							</select>
						</label>
						<label v-if="form.scope_type !== 'Network'"
							>Партнёр
							<select v-model="form.organization" required>
								<option value="">Не выбран</option>
								<option
									v-for="item in options.organizations"
									:key="item.name"
									:value="item.name"
								>
									{{ item.organization_name }}
								</option>
							</select>
						</label>
						<label
							v-if="
								form.scope_type === 'Business Entity' ||
								form.scope_type === 'Points'
							"
							>Юридическое лицо
							<select v-model="form.business_entity" required>
								<option value="">Не выбрано</option>
								<option
									v-for="item in availableEntities"
									:key="item.name"
									:value="item.name"
								>
									{{ item.short_name }}
								</option>
							</select>
						</label>
						<label
							>Часовой пояс
							<select v-model="form.time_zone">
								<option value="">Системный — {{ options.system_timezone || "определяется Frappe" }}</option>
								<option v-for="zone in options.timezones" :key="zone" :value="zone">
									{{ zone }}
								</option>
							</select>
						</label>
						<label
							>Связанный сотрудник
							<select v-model="form.linked_employee">
								<option value="">Не связан</option>
								<option
									v-for="item in options.employees"
									:key="item.name"
									:value="item.name"
								>
									{{ item.employee_name }}
								</option>
							</select>
						</label>
					</div>
				</div>
				<div v-if="form.scope_type === 'Points'" class="form-section">
					<h3>Доступные точки</h3>
					<p v-if="!form.business_entity" class="form-hint">
						Сначала выберите партнёра и юридическое лицо.
					</p>
					<div class="point-picker">
						<label v-for="point in availablePoints" :key="point.name">
							<input
								type="checkbox"
								:checked="hasPoint(point.name)"
								@change="togglePoint(point)"
							/>
							{{ point.point_name }}
						</label>
					</div>
				</div>
				<div v-if="form.name" class="form-section">
					<h3>Приглашение и безопасность</h3>
					<div class="security-actions">
						<button
							type="button"
							class="button button-secondary"
							@click="generateInvitation"
						>
							Создать ссылку для первого входа
						</button>
						<button
							type="button"
							class="button button-secondary"
							@click="closeSessions"
						>
							Завершить сеансы
						</button>
					</div>
					<div v-if="invitation" class="invitation">
						<textarea :value="invitation" rows="6" readonly></textarea>
						<button
							type="button"
							class="button button-secondary"
							@click="copyInvitation"
						>
							Копировать сообщение
						</button>
					</div>
				</div>
				<p v-if="formError" class="form-error">{{ formError }}</p>
			</form>
			<template #footer>
				<div v-if="form.name" class="danger-actions">
					<button class="text-button" @click="setActive(form.active ? 0 : 1)">
						{{ form.active ? "Отключить пользователя" : "Включить пользователя" }}
					</button>
				</div>
				<div class="footer-actions">
					<button class="button button-secondary" @click="detail = null">Закрыть</button>
					<button class="button button-primary" :disabled="saving" @click="save">
						{{ saving ? "Сохраняем…" : "Сохранить" }}
					</button>
				</div>
			</template>
		</AppModal>
	</section>
</template>

<style scoped>
.time-diagnostics {
	margin: 0 0 18px;
	padding: 14px 16px;
	border: 1px solid var(--border-color, #d9dee7);
	border-radius: 10px;
	background: var(--surface-muted, #f8fafc);
}
.time-diagnostics-header {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 12px;
}
.time-diagnostics-header h3 {
	margin: 0 0 10px;
}
.time-diagnostics-grid {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 12px;
}
.time-diagnostics-grid > div {
	display: grid;
	gap: 3px;
}
.diagnostic-label {
	color: var(--text-muted, #667085);
	font-size: 12px;
}
.time-diagnostics small {
	color: var(--text-muted, #667085);
}
.diagnostic-points {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 12px;
	margin-top: 12px;
}
.diagnostic-point {
	font-size: 13px;
}
.diagnostic-warnings {
	margin: 10px 0 0;
	padding-left: 18px;
	color: var(--danger, #b42318);
	font-size: 13px;
}
.security-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
}
.invitation {
	display: grid;
	gap: 10px;
	margin-top: 14px;
}
.invitation textarea {
	width: 100%;
	resize: vertical;
}
</style>
