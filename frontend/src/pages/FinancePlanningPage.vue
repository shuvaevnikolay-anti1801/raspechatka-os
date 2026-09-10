<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { call, canAccess } from "../api";
const month = ref(new Date().toISOString().slice(0, 7)),
	entity = ref(""),
	point = ref(""),
	form = reactive({ lines: [] }),
	options = reactive({ entities: [], points: [], articles: [] }),
	loading = ref(true),
	saving = ref(false),
	error = ref("");
const canEdit = computed(() => canAccess("finance.planning", "Edit"));
const points = computed(() =>
	options.points.filter((x) => !entity.value || x.business_entity === entity.value),
);
const money = (v) =>
	new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(
		Number(v || 0),
	);
const calculatedRevenue = computed(
	() => Number(form.checks_plan || 0) * Number(form.average_check_plan || 0),
);
async function load() {
	loading.value = true;
	error.value = "";
	try {
		const data = await call("raspechatka.api.finance.get_budget", {
			month: `${month.value}-01`,
			business_entity: entity.value,
			business_point: point.value,
		});
		Object.keys(form).forEach((k) => delete form[k]);
		Object.assign(form, data);
		form.lines ||= [];
	} catch (e) {
		error.value = e.message;
	} finally {
		loading.value = false;
	}
}
async function init() {
	Object.assign(options, await call("raspechatka.api.finance.get_finance_options"));
	entity.value = options.entities[0]?.name || "";
	await load();
}
function addLine() {
	form.lines.push({ financial_article: "", amount: 0, comment: "" });
}
async function save() {
	saving.value = true;
	try {
		form.month = `${month.value}-01`;
		form.business_entity = entity.value;
		form.business_point = point.value;
		form.revenue_plan = form.revenue_plan || calculatedRevenue.value;
		const r = await call(
			"raspechatka.api.finance.save_budget",
			{ data: JSON.stringify(form) },
			{ method: "POST" },
		);
		form.name = r.name;
		await load();
	} catch (e) {
		error.value = e.message;
	} finally {
		saving.value = false;
	}
}
onMounted(init);
</script>
<template>
	<section class="page finance-page">
		<div class="page-heading">
			<div>
				<div class="eyebrow">ФИНАНСЫ / МОДЕЛЬ</div>
				<h1>План и финансовая модель</h1>
				<p>План-факт месяца и основные драйверы бизнеса</p>
			</div>
			<button v-if="canEdit" class="button button-primary" :disabled="saving" @click="save">
				{{ saving ? "Сохраняем…" : "Сохранить план" }}
			</button>
		</div>
		<div class="finance-toolbar calendar-toolbar">
			<input v-model="month" type="month" @change="load" /><select
				v-model="entity"
				@change="
					point = '';
					load();
				"
			>
				<option v-for="x in options.entities" :key="x.name" :value="x.name">
					{{ x.short_name }}
				</option></select
			><select v-model="point" @change="load">
				<option value="">В целом по ИП</option>
				<option v-for="x in points" :key="x.name" :value="x.name">
					{{ x.point_name }}
				</option>
			</select>
		</div>
		<div v-if="loading" class="table-message"><span class="loader"></span></div>
		<template v-else
			><div class="model-driver-grid">
				<label
					><span>Чеков в месяц</span
					><input
						v-model.number="form.checks_plan"
						type="number"
						min="0"
						:disabled="!canEdit" /></label
				><label
					><span>Средний чек</span
					><input
						v-model.number="form.average_check_plan"
						type="number"
						min="0"
						step="0.01"
						:disabled="!canEdit"
					/><small>₽</small></label
				>
				<article>
					<span>Расчётная выручка</span><b>{{ money(calculatedRevenue) }} ₽</b>
				</article>
				<label
					><span>План выручки</span
					><input
						v-model.number="form.revenue_plan"
						type="number"
						min="0"
						step="0.01"
						:disabled="!canEdit"
					/><small>₽</small></label
				><label
					><span>План чистой прибыли</span
					><input
						v-model.number="form.net_profit_plan"
						type="number"
						step="0.01"
						:disabled="!canEdit"
					/><small>₽</small></label
				>
				<label
					><span>Новые участники клуба</span
					><input
						v-model.number="form.club_members_plan"
						type="number"
						min="0"
						:disabled="!canEdit" /></label
				><label
					><span>Отзывы</span
					><input
						v-model.number="form.reviews_plan"
						type="number"
						min="0"
						:disabled="!canEdit" /></label
				>
			</div>
			<div class="finance-report-grid planning-grid">
				<article class="finance-panel">
					<header>
						<small>ПЛАН РАСХОДОВ И ДОХОДОВ</small>
						<h2>Статьи месяца</h2>
						<button v-if="canEdit" class="text-button" @click="addLine">
							＋ Добавить статью
						</button>
					</header>
					<div class="budget-lines">
						<div v-for="(row, i) in form.lines" :key="i">
							<select v-model="row.financial_article" :disabled="!canEdit">
								<option value="">Выберите статью</option>
								<option
									v-for="x in options.articles"
									:key="x.name"
									:value="x.name"
								>
									{{ x.article_name }}
								</option></select
							><input
								v-model.number="row.amount"
								type="number"
								step="0.01"
								:disabled="!canEdit"
							/><button v-if="canEdit" @click="form.lines.splice(i, 1)">×</button>
						</div>
					</div>
				</article>
				<article class="finance-panel">
					<header>
						<small>ДЕНЕЖНАЯ ПОЗИЦИЯ</small>
						<h2>Начало месяца и баланс</h2>
					</header>
					<div class="balance-inputs">
						<label
							>Деньги на начало<input
								v-model.number="form.opening_cash_plan"
								type="number"
								step="0.01"
								:disabled="!canEdit" /></label
						><label
							>Стоимость оборудования<input
								v-model.number="form.equipment_value"
								type="number"
								step="0.01"
								:disabled="!canEdit" /></label
						><label
							>Кредиты и займы<input
								v-model.number="form.loan_balance"
								type="number"
								step="0.01"
								:disabled="!canEdit" /></label
						><label
							>Прочие обязательства<input
								v-model.number="form.other_liabilities"
								type="number"
								step="0.01"
								:disabled="!canEdit"
						/></label>
					</div>
				</article></div
		></template>
		<p v-if="error" class="form-error">{{ error }}</p>
	</section>
</template>
