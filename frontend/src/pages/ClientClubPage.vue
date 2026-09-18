<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { call, canAccess } from "../api";
import AppModal from "../components/AppModal.vue";
const stats = reactive({}),
	form = reactive({ discount_rules: [] }),
	loading = ref(true),
	saving = ref(false),
	recalculating = ref(false),
	recalculationOpen = ref(false),
	recalculationResult = ref(null),
	savedSettings = ref(""),
	error = ref("");
const canEdit = computed(() => canAccess("page.clients.club", "Edit"));
const settingsFingerprint = computed(() => JSON.stringify(form));
const hasUnsavedSettings = computed(
	() => Boolean(savedSettings.value) && settingsFingerprint.value !== savedSettings.value
);
async function load() {
	loading.value = true;
	try {
		const [dashboard, settings] = await Promise.all([
			call("raspechatka.api.clients.get_club_dashboard"),
			call("raspechatka.api.clients.get_loyalty_settings"),
		]);
		Object.assign(stats, dashboard);
		Object.assign(form, settings);
		savedSettings.value = JSON.stringify(form);
	} catch (e) {
		error.value = e.message;
	} finally {
		loading.value = false;
	}
}
function openRecalculation() {
	recalculationResult.value = null;
	recalculationOpen.value = true;
}
function closeRecalculation() {
	if (!recalculating.value) recalculationOpen.value = false;
}
async function recalculateDiscounts() {
	recalculating.value = true;
	error.value = "";
	try {
		recalculationResult.value = await call(
			"raspechatka.api.clients.run_loyalty_discount_recalculation",
			{},
			{ method: "POST" }
		);
		Object.assign(stats, await call("raspechatka.api.clients.get_club_dashboard"));
	} catch (e) {
		error.value = e.message;
		recalculationOpen.value = false;
	} finally {
		recalculating.value = false;
	}
}
async function save() {
	saving.value = true;
	error.value = "";
	try {
		await call(
			"raspechatka.api.clients.save_loyalty_settings",
			{ data: JSON.stringify(form) },
			{ method: "POST" }
		);
		await load();
	} catch (e) {
		error.value = e.message;
	} finally {
		saving.value = false;
	}
}
function addRule() {
	form.discount_rules.push({
		active_channel_count: form.discount_rules.length,
		discount_percent: 0,
		active: 1,
	});
}
onMounted(load);
</script>
<template>
	<section class="page club-page">
		<div class="page-heading">
			<div>
				<div class="eyebrow">КЛИЕНТЫ / ЛОЯЛЬНОСТЬ</div>
				<h1>Клуб Распечатка</h1>
				<p>Регистрация, каналы связи, скидки и возврат клиентов</p>
			</div>
			<button v-if="canEdit" class="button button-primary" :disabled="saving" @click="save">
				{{ saving ? "Сохраняем…" : "Сохранить настройки" }}
			</button>
		</div>
		<div v-if="loading" class="table-message">
			<span class="loader"></span><span>Загружаем клуб…</span>
		</div>
		<template v-else
			><div class="club-metrics">
				<article>
					<small>КЛИЕНТСКАЯ БАЗА</small><b>{{ stats.total_clients || 0 }}</b
					><span>клиентов во всей сети</span>
				</article>
				<article class="accent">
					<small>НОВЫХ В ЭТОМ МЕСЯЦЕ</small><b>+{{ stats.new_this_month || 0 }}</b
					><span>активных {{ stats.active_clients || 0 }}</span>
				</article>
				<article>
					<small>ПРАЗДНИКОВ В МЕСЯЦЕ</small><b>{{ stats.birthdays_this_month || 0 }}</b
					><span>можно включить в сегмент</span>
				</article>
				<article>
					<small>РАССЫЛКИ → ПОКУПКИ</small
					><b>{{ stats.purchases_from_campaigns || 0 }}</b
					><span>из {{ stats.sent_total || 0 }} отправлений</span>
				</article>
			</div>
			<div class="club-layout">
				<div class="settings-panel">
					<h2>Правила скидок</h2>
					<p>Скидка на кассе пересчитывается по числу активных каналов.</p>
					<div v-if="canEdit" class="recalculation-action">
						<button
							class="button button-secondary"
							:disabled="recalculating || hasUnsavedSettings"
							:title="
								hasUnsavedSettings
									? 'Сначала сохраните изменённые настройки'
									: 'Применить сохранённые правила ко всей клиентской базе'
							"
							@click="openRecalculation"
						>
							{{ recalculating ? "Пересчитываем…" : "Пересчитать скидки" }}
						</button>
						<small v-if="hasUnsavedSettings">
							Сначала сохраните настройки — пересчёт использует только данные
							backend.
						</small>
					</div>
					<div class="discount-rules">
						<div v-for="(rule, index) in form.discount_rules" :key="index">
							<input
								v-model.number="rule.active_channel_count"
								type="number"
								min="0"
								:disabled="!canEdit"
							/><span>активных каналов</span
							><input
								v-model.number="rule.discount_percent"
								type="number"
								min="0"
								:max="form.maximum_discount_percent"
								step="0.1"
								:disabled="!canEdit"
							/><b>%</b
							><label
								><input
									v-model="rule.active"
									type="checkbox"
									:true-value="1"
									:false-value="0"
									:disabled="!canEdit"
								/>
								действует</label
							>
						</div>
					</div>
					<button v-if="canEdit" class="text-button" @click="addRule">
						＋ Добавить правило
					</button>
					<div class="form-grid settings-grid">
						<label
							>Максимум активных каналов<input
								v-model.number="form.max_active_channels"
								type="number"
								min="1"
								:disabled="!canEdit" /></label
						><label
							>Максимальная скидка, %<input
								v-model.number="form.maximum_discount_percent"
								type="number"
								min="0"
								max="100"
								:disabled="!canEdit" /></label
						><label
							>Срок сессии, дней<input
								v-model.number="form.session_lifetime_days"
								type="number"
								min="1"
								:disabled="!canEdit"
						/></label>
					</div>
				</div>
				<div class="settings-panel">
					<h2>Согласия и документы</h2>
					<p>Версия и ссылка сохраняются в аудите при каждом согласии.</p>
					<div class="document-settings">
						<div>
							<label
								><input
									v-model="form.personal_data_required"
									type="checkbox"
									:true-value="1"
									:false-value="0"
									:disabled="!canEdit"
								/>
								Персональные данные</label
							><input
								v-model="form.personal_data_version"
								placeholder="Версия"
								:disabled="!canEdit"
							/><input
								v-model="form.personal_data_url"
								placeholder="URL документа"
								:disabled="!canEdit"
							/>
						</div>
						<div>
							<label
								><input
									v-model="form.marketing_required"
									type="checkbox"
									:true-value="1"
									:false-value="0"
									:disabled="!canEdit"
								/>
								Рекламные сообщения</label
							><input
								v-model="form.marketing_version"
								placeholder="Версия"
								:disabled="!canEdit"
							/><input
								v-model="form.marketing_url"
								placeholder="URL документа"
								:disabled="!canEdit"
							/>
						</div>
						<div>
							<label
								><input
									v-model="form.club_rules_required"
									type="checkbox"
									:true-value="1"
									:false-value="0"
									:disabled="!canEdit"
								/>
								Правила клуба</label
							><input
								v-model="form.club_rules_version"
								placeholder="Версия"
								:disabled="!canEdit"
							/><input
								v-model="form.club_rules_url"
								placeholder="URL документа"
								:disabled="!canEdit"
							/>
						</div>
					</div>
					<h3 class="integration-title">Ссылки мессенджеров</h3>
					<div class="form-grid">
						<label
							>Telegram<input
								v-model="form.telegram_connect_url"
								placeholder="https://..."
								:disabled="!canEdit" /></label
						><label
							>MAX<input
								v-model="form.max_connect_url"
								placeholder="https://..."
								:disabled="!canEdit" /></label
						><label
							>VK<input
								v-model="form.vk_connect_url"
								placeholder="https://..."
								:disabled="!canEdit"
						/></label>
					</div>
				</div></div
		></template>
		<p v-if="error" class="form-error">{{ error }}</p>
		<AppModal
			v-if="recalculationOpen"
			title="Пересчитать скидки всей клиентской базы?"
			@close="closeRecalculation"
		>
			<div v-if="!recalculationResult" class="recalculation-confirmation">
				<p>
					Система пересчитает скидки всех клиентов согласно сохранённым правилам клуба,
					активным каналам, согласиям и статусу клиента.
				</p>
				<p>Существующие рассчитанные значения скидок будут заменены.</p>
			</div>
			<div v-else class="recalculation-result">
				<h3>Пересчёт завершён</h3>
				<dl>
					<div>
						<dt>Обработано</dt>
						<dd>{{ recalculationResult.processed }}</dd>
					</div>
					<div>
						<dt>Изменено</dt>
						<dd>{{ recalculationResult.changed }}</dd>
					</div>
					<div>
						<dt>Без изменений</dt>
						<dd>{{ recalculationResult.unchanged }}</dd>
					</div>
					<div>
						<dt>Скидка 0%</dt>
						<dd>{{ recalculationResult.zero_discount }}</dd>
					</div>
					<div>
						<dt>Ненулевая скидка</dt>
						<dd>{{ recalculationResult.nonzero_discount }}</dd>
					</div>
					<div v-if="recalculationResult.errors">
						<dt>Ошибки</dt>
						<dd>{{ recalculationResult.errors }}</dd>
					</div>
				</dl>
			</div>
			<template #footer>
				<button
					class="button button-secondary"
					:disabled="recalculating"
					@click="closeRecalculation"
				>
					{{ recalculationResult ? "Закрыть" : "Отмена" }}
				</button>
				<button
					v-if="!recalculationResult"
					class="button button-primary"
					:disabled="recalculating"
					@click="recalculateDiscounts"
				>
					{{ recalculating ? "Пересчитываем…" : "Пересчитать скидки" }}
				</button>
			</template>
		</AppModal>
	</section>
</template>

<style scoped>
.recalculation-action {
	display: flex;
	align-items: center;
	gap: 12px;
	margin: 14px 0 18px;
}
.recalculation-action small {
	max-width: 360px;
	color: var(--muted);
}
.recalculation-confirmation {
	display: grid;
	gap: 10px;
	line-height: 1.5;
}
.recalculation-confirmation p {
	margin: 0;
}
.recalculation-result h3 {
	margin: 0 0 14px;
}
.recalculation-result dl {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 10px;
	margin: 0;
}
.recalculation-result dl > div {
	padding: 12px;
	border: 1px solid var(--border);
	border-radius: 10px;
	background: #fafbf9;
}
.recalculation-result dt {
	color: var(--muted);
	font-size: 12px;
}
.recalculation-result dd {
	margin: 4px 0 0;
	font-size: 22px;
	font-weight: 700;
}
@media (max-width: 620px) {
	.recalculation-action {
		align-items: stretch;
		flex-direction: column;
	}
	.recalculation-result dl {
		grid-template-columns: 1fr;
	}
}
</style>
