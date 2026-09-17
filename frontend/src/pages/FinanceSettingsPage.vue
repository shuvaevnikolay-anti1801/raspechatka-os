<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { call } from "../api";
import AppModal from "../components/AppModal.vue";
import ListPageHeader from "../components/ListPageHeader.vue";

const data = reactive({ articles: [], rules: [], review_operations: [], entities: [], points: [], accounts: [] });
const loading = ref(true);
const error = ref("");
const saving = ref("");
const ruleOpen = ref(false);
const drafts = reactive({ Income: "", Expense: "" });
const ruleForm = reactive({});
const reviewRows = ref([]);
const groups = computed(() => ({
	Income: data.articles.filter((item) => item.article_type === "Income"),
	Expense: data.articles.filter((item) => item.article_type === "Expense"),
}));
const ruleArticles = computed(() => data.articles.filter((item) => item.active && (!ruleForm.direction || ruleForm.direction === "Any" || item.article_type === ruleForm.direction)));
const money = (value) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(Number(value || 0));
const directionLabel = (value) => value === "Income" ? "Приход" : value === "Expense" ? "Расход" : "Любая";
const resultLabel = (value) => value === "Approve" ? "Учитывать" : value === "Ignore" ? "Исключать" : "На проверку";
const pointsFor = (entity) => data.points.filter((item) => !entity || item.business_entity === entity);
const articlesFor = (direction) => data.articles.filter((item) => item.active && item.article_type === direction);

async function load() {
	loading.value = true;
	error.value = "";
	try {
		const result = await call("raspechatka.api.finance.get_finance_settings");
		Object.assign(data, result);
		reviewRows.value = (result.review_operations || []).map((item) => ({ ...item, selected_article: "", selected_point: "" }));
	} catch (exception) {
		error.value = exception.message;
	} finally {
		loading.value = false;
	}
}
async function createArticle(type) {
	const articleName = drafts[type].trim();
	if (!articleName) return;
	saving.value = type;
	try {
		await call("raspechatka.api.finance.save_financial_article", { data: JSON.stringify({ article_name: articleName, article_type: type, active: 1 }) }, { method: "POST" });
		drafts[type] = "";
		await load();
	} catch (exception) {
		error.value = exception.message;
	} finally {
		saving.value = "";
	}
}
async function saveArticle(article) {
	saving.value = article.name;
	try {
		await call("raspechatka.api.finance.save_financial_article", { data: JSON.stringify(article) }, { method: "POST" });
		await load();
	} catch (exception) {
		error.value = exception.message;
	} finally {
		saving.value = "";
	}
}
async function archiveArticle(article) {
	if (!confirm(`Перенести статью «${article.article_name}» в архив?`)) return;
	saving.value = article.name;
	try {
		await call("raspechatka.api.finance.delete_financial_article", { name: article.name }, { method: "POST" });
		await load();
	} catch (exception) {
		error.value = exception.message;
	} finally {
		saving.value = "";
	}
}
function openRule(rule = null) {
	Object.keys(ruleForm).forEach((key) => delete ruleForm[key]);
	Object.assign(ruleForm, rule || {
		rule_name: "",
		priority: 100,
		enabled: 1,
		stop_processing: 1,
		direction: "Income",
		result: "Approve",
		business_entity: "",
		bank_account: "",
		business_point: "",
		counterparty_inn: "",
		counterparty_account: "",
		counterparty_contains: "",
		purpose_contains: "",
		purpose_regex: "",
		amount_from: "",
		amount_to: "",
		financial_article: "",
	});
	ruleOpen.value = true;
}
async function saveRule() {
	saving.value = "rule";
	error.value = "";
	try {
		await call("raspechatka.api.finance.save_classification_rule", { data: JSON.stringify(ruleForm) }, { method: "POST" });
		ruleOpen.value = false;
		await load();
	} catch (exception) {
		error.value = exception.message;
	} finally {
		saving.value = "";
	}
}
async function archiveRule(rule) {
	if (!confirm(`Отключить правило «${rule.rule_name}»?`)) return;
	try {
		await call("raspechatka.api.finance.archive_classification_rule", { name: rule.name }, { method: "POST" });
		await load();
	} catch (exception) {
		error.value = exception.message;
	}
}
async function processReview(row, result = "Approve", remember = false) {
	saving.value = row.name;
	error.value = "";
	try {
		await call("raspechatka.api.finance.classify_bank_operation", {
			name: row.name,
			financial_article: row.selected_article,
			business_point: row.selected_point,
			result,
			remember: remember ? 1 : 0,
		}, { method: "POST" });
		await load();
	} catch (exception) {
		error.value = exception.message;
	} finally {
		saving.value = "";
	}
}
async function reprocess() {
	saving.value = "reprocess";
	try {
		const result = await call("raspechatka.api.finance.reprocess_bank_operations", {}, { method: "POST" });
		await load();
		alert(`По правилам обработано операций: ${result.processed}`);
	} catch (exception) {
		error.value = exception.message;
	} finally {
		saving.value = "";
	}
}

onMounted(load);
</script>

<template>
	<section class="page finance-settings">
		<ListPageHeader title="Настройки финансов" />
		<router-link class="bank-settings-link" to="/finance/settings/tochka">
			<div><small>ИНТЕГРАЦИИ</small><strong>Точка Банк</strong><span>Подключения ИП, согласия владельцев и автоматическая загрузка выписок.</span></div>
			<b>Настроить →</b>
		</router-link>

		<div v-if="loading" class="table-message"><span class="loader"></span><span>Загружаем настройки…</span></div>
		<template v-else>
			<div class="settings-intro">
				<div><strong>Финансовые статьи</strong><span>Единый справочник сети для платежей и отчётности.</span></div>
				<span class="system-hint"><i></i> Системные статьи защищены</span>
			</div>
			<div class="article-columns">
				<article v-for="type in ['Income', 'Expense']" :key="type" class="article-panel">
					<header><div><small>{{ type === "Income" ? "ПОСТУПЛЕНИЯ" : "ВЫПЛАТЫ" }}</small><h2>{{ type === "Income" ? "Статьи доходов" : "Статьи расходов" }}</h2></div><span>{{ groups[type].length }}</span></header>
					<div class="article-create"><input v-model="drafts[type]" :placeholder="type === 'Income' ? 'Новая статья дохода' : 'Новая статья расхода'" @keyup.enter="createArticle(type)" /><button class="button button-primary" :disabled="saving === type" @click="createArticle(type)">Добавить</button></div>
					<div class="article-list">
						<div v-for="article in groups[type]" :key="article.name" class="article-row" :class="{ inactive: !article.active }">
							<div class="article-name"><input v-if="!article.system_article" v-model="article.article_name" :disabled="saving === article.name || !article.active" @change="saveArticle(article)" /><strong v-else>{{ article.article_name }}</strong><small>{{ article.active ? "Активна" : "В архиве" }}</small></div>
							<span v-if="article.system_article" class="system-badge">Системная</span>
							<div v-else class="article-actions"><label title="Активна"><input v-model="article.active" type="checkbox" :true-value="1" :false-value="0" @change="saveArticle(article)" /></label><button v-if="article.active" type="button" title="В архив" :disabled="saving === article.name" @click="archiveArticle(article)">×</button></div>
						</div>
					</div>
				</article>
			</div>

			<section class="rules-section">
				<div class="section-title">
					<div><small>АВТОМАТИЧЕСКАЯ ОБРАБОТКА</small><h2>Правила платежей</h2><span>Правила применяются ко всем новым выпискам сети в порядке приоритета.</span></div>
					<div class="section-actions"><button class="button button-secondary" :disabled="saving === 'reprocess'" @click="reprocess">Обработать ожидающие</button><button class="button button-primary" @click="openRule()">＋ Правило</button></div>
				</div>
				<div class="rules-list">
					<button v-for="rule in data.rules" :key="rule.name" class="rule-row" :class="{ inactive: !rule.enabled }" @click="openRule(rule)">
						<span class="rule-priority">{{ rule.priority }}</span>
						<span><strong>{{ rule.rule_name }}</strong><small>{{ directionLabel(rule.direction) }} · {{ resultLabel(rule.result) }} · {{ rule.financial_article || "без статьи" }}</small></span>
						<span>{{ rule.business_entity || "Вся сеть" }}</span>
						<span>{{ rule.match_count || 0 }} применений</span>
						<i @click.stop="archiveRule(rule)">Отключить</i>
					</button>
					<p v-if="!data.rules.length" class="empty-articles">Правил пока нет</p>
				</div>
			</section>

			<section class="review-section">
				<div class="section-title"><div><small>ОЧЕРЕДЬ ПРОВЕРКИ</small><h2>Нераспознанные операции</h2><span>После подтверждения операция появится в «Платежах».</span></div><b class="review-count">{{ reviewRows.length }}</b></div>
				<div v-for="row in reviewRows" :key="row.name" class="review-row">
					<div class="review-main"><small>{{ row.business_entity }} · {{ directionLabel(row.direction) }} · {{ row.posted_at }}</small><strong>{{ row.counterparty_name || "Без контрагента" }}</strong><span>{{ row.purpose || "Без назначения" }}</span></div>
					<b>{{ money(row.amount) }}</b>
					<select v-model="row.selected_article"><option value="">Выберите статью</option><option v-for="article in articlesFor(row.direction)" :key="article.name" :value="article.name">{{ article.article_name }}</option></select>
					<select v-model="row.selected_point"><option value="">Без точки</option><option v-for="point in pointsFor(row.business_entity)" :key="point.name" :value="point.name">{{ point.point_name }}</option></select>
					<div class="review-actions"><button class="button button-secondary" :disabled="saving === row.name" @click="processReview(row, 'Ignore')">Исключить</button><button class="button button-secondary" :disabled="!row.selected_article || saving === row.name" @click="processReview(row)">Учесть</button><button class="button button-primary" :disabled="!row.selected_article || saving === row.name" @click="processReview(row, 'Approve', true)">Учесть и запомнить</button></div>
				</div>
				<p v-if="!reviewRows.length" class="empty-review">Все банковские операции обработаны.</p>
			</section>
		</template>
		<p v-if="error" class="form-error">{{ error }}</p>

		<AppModal v-if="ruleOpen" :title="ruleForm.name ? 'Правило обработки' : 'Новое правило'" wide @close="ruleOpen = false">
			<div class="form-grid">
				<label class="span-2">Название<input v-model="ruleForm.rule_name" required /></label>
				<label>Приоритет<input v-model.number="ruleForm.priority" type="number" min="1" /></label>
				<label>Направление<select v-model="ruleForm.direction"><option value="Any">Любое</option><option value="Income">Приход</option><option value="Expense">Расход</option></select></label>
				<label>ИП<select v-model="ruleForm.business_entity"><option value="">Вся сеть</option><option v-for="entity in data.entities" :key="entity.name" :value="entity.name">{{ entity.short_name }}</option></select></label>
				<label>Точка результата<select v-model="ruleForm.business_point"><option value="">Без точки</option><option v-for="point in pointsFor(ruleForm.business_entity)" :key="point.name" :value="point.name">{{ point.point_name }}</option></select></label>
				<label>Контрагент содержит<input v-model="ruleForm.counterparty_contains" /></label>
				<label>ИНН контрагента<input v-model="ruleForm.counterparty_inn" /></label>
				<label>Счёт контрагента<input v-model="ruleForm.counterparty_account" /></label>
				<label>Назначение содержит<input v-model="ruleForm.purpose_contains" /></label>
				<label class="span-2">Регулярное выражение назначения<input v-model="ruleForm.purpose_regex" /></label>
				<label>Сумма от<input v-model.number="ruleForm.amount_from" type="number" min="0" step="0.01" /></label>
				<label>Сумма до<input v-model.number="ruleForm.amount_to" type="number" min="0" step="0.01" /></label>
				<label>Результат<select v-model="ruleForm.result"><option value="Approve">Учитывать</option><option value="Review">Отправлять на проверку</option><option value="Ignore">Исключать</option></select></label>
				<label>Финансовая статья<select v-model="ruleForm.financial_article" :required="ruleForm.result === 'Approve'"><option value="">Без статьи</option><option v-for="article in ruleArticles" :key="article.name" :value="article.name">{{ article.article_name }}</option></select></label>
				<label class="check-field"><input v-model="ruleForm.enabled" type="checkbox" :true-value="1" :false-value="0" /> Правило включено</label>
			</div>
			<template #footer><span></span><div class="footer-actions"><button class="button button-secondary" @click="ruleOpen = false">Отмена</button><button class="button button-primary" :disabled="saving === 'rule'" @click="saveRule">Сохранить</button></div></template>
		</AppModal>
	</section>
</template>

<style scoped>
.bank-settings-link,.settings-intro,.rules-section,.review-section{margin-bottom:18px;padding:16px 18px;border:1px solid var(--border);border-radius:14px;background:var(--surface)}
.bank-settings-link{display:flex;align-items:center;justify-content:space-between;gap:20px;color:var(--ink);text-decoration:none}.bank-settings-link div{display:grid;gap:3px}.bank-settings-link small,.section-title small{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.08em}.bank-settings-link span,.section-title span{color:var(--muted);font-size:13px}.bank-settings-link b{color:var(--green-dark);white-space:nowrap}
.settings-intro,.section-title{display:flex;align-items:center;justify-content:space-between;gap:20px}.settings-intro div,.section-title>div:first-child{display:grid;gap:3px}.settings-intro span{color:var(--muted);font-size:13px}.system-hint{display:flex;align-items:center;gap:7px;white-space:nowrap}.system-hint i{width:8px;height:8px;border-radius:50%;background:var(--green)}
.article-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-bottom:18px}.article-panel{overflow:hidden;border:1px solid var(--border);border-radius:16px;background:var(--surface)}.article-panel>header{display:flex;align-items:center;justify-content:space-between;padding:18px;border-bottom:1px solid var(--border)}.article-panel header div{display:grid;gap:3px}.article-panel header small{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.08em}.article-panel h2,.section-title h2{margin:0;font-size:18px}.article-panel header>span,.review-count{min-width:30px;padding:5px 8px;border-radius:999px;background:var(--surface-subtle);text-align:center;font-size:12px}.article-create{display:grid;grid-template-columns:1fr auto;gap:8px;padding:12px;border-bottom:1px solid var(--border)}.article-list{display:grid}.article-row{display:flex;align-items:center;gap:12px;min-height:58px;padding:9px 12px;border-bottom:1px solid var(--border)}.article-row.inactive,.rule-row.inactive{opacity:.55}.article-name{display:grid;flex:1;gap:3px;min-width:0}.article-name small,.rule-row small{color:var(--muted);font-size:10px}.system-badge{padding:4px 7px;border-radius:999px;background:var(--green-soft);color:var(--green-dark);font-size:10px;font-weight:700}.article-actions{display:flex;align-items:center;gap:8px}.article-actions button{width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--danger);font-size:20px;cursor:pointer}
.section-actions,.review-actions{display:flex;flex-wrap:wrap;gap:8px}.rules-list{display:grid;margin-top:16px;border-top:1px solid var(--border)}.rule-row{display:grid;grid-template-columns:44px minmax(220px,1fr) minmax(150px,.5fr) 120px auto;align-items:center;gap:12px;padding:12px 0;border:0;border-bottom:1px solid var(--border);background:transparent;color:var(--ink);text-align:left;cursor:pointer}.rule-row>span:nth-child(2){display:grid;gap:3px}.rule-row i{color:var(--danger);font-size:12px;font-style:normal}.rule-priority{font-weight:700}
.review-section{padding-bottom:0}.review-row{display:grid;grid-template-columns:minmax(260px,1fr) 120px minmax(180px,.5fr) minmax(150px,.4fr);gap:12px;align-items:center;padding:14px 0;border-top:1px solid var(--border)}.review-main{display:grid;gap:3px}.review-main small,.review-main span{color:var(--muted);font-size:12px}.review-actions{grid-column:1/-1;justify-content:flex-end}.empty-review,.empty-articles{padding:24px;color:var(--muted);text-align:center}
@media(max-width:900px){.article-columns{grid-template-columns:1fr}.settings-intro,.section-title{align-items:flex-start;flex-direction:column}.rule-row,.review-row{grid-template-columns:1fr}.review-actions{grid-column:auto;justify-content:flex-start}.section-actions{width:100%}}
</style>
