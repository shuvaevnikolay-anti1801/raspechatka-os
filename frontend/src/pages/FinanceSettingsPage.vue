<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { call } from "../api";
import ListPageHeader from "../components/ListPageHeader.vue";

const articles = ref([]);
const loading = ref(true);
const error = ref("");
const saving = ref("");
const drafts = reactive({ Income: "", Expense: "" });

const groups = computed(() => ({
	Income: articles.value.filter((item) => item.article_type === "Income"),
	Expense: articles.value.filter((item) => item.article_type === "Expense"),
}));

async function load() {
	loading.value = true;
	error.value = "";
	try {
		const result = await call("raspechatka.api.finance.get_finance_settings");
		articles.value = result.articles || [];
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
	error.value = "";
	try {
		await call("raspechatka.api.finance.save_financial_article", {
			data: JSON.stringify({ article_name: articleName, article_type: type, active: 1 }),
		}, { method: "POST" });
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
	error.value = "";
	try {
		await call("raspechatka.api.finance.save_financial_article", {
			data: JSON.stringify(article),
		}, { method: "POST" });
		await load();
	} catch (exception) {
		error.value = exception.message;
	} finally {
		saving.value = "";
	}
}
async function removeArticle(article) {
	if (!confirm(`Удалить статью «${article.article_name}»?`)) return;
	saving.value = article.name;
	error.value = "";
	try {
		await call("raspechatka.api.finance.delete_financial_article", {
			name: article.name,
		}, { method: "POST" });
		await load();
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
		<ListPageHeader title="Настройки" />
\t\t<router-link class="bank-settings-link" to="/finance/settings/tochka"><div><small>ИНТЕГРАЦИИ</small><strong>Точка Банк</strong><span>Подключения ИП, согласия владельцев и загрузка выписок.</span></div><b>Настроить →</b></router-link>
		<div class="settings-intro">
			<div>
				<strong>Финансовые статьи</strong>
				<span>Названия для платежей, планирования и финансовых отчётов.</span>
			</div>
			<span class="system-hint"><i></i> Системные статьи защищены</span>
		</div>
		<div v-if="loading" class="table-message"><span class="loader"></span><span>Загружаем настройки…</span></div>
		<div v-else class="article-columns">
			<article v-for="type in ['Income', 'Expense']" :key="type" class="article-panel">
				<header>
					<div>
						<small>{{ type === "Income" ? "ПОСТУПЛЕНИЯ" : "ВЫПЛАТЫ" }}</small>
						<h2>{{ type === "Income" ? "Статьи доходов" : "Статьи расходов" }}</h2>
					</div>
					<span>{{ groups[type].length }}</span>
				</header>
				<div class="article-create">
					<input
						v-model="drafts[type]"
						:placeholder="type === 'Income' ? 'Новая статья дохода' : 'Новая статья расхода'"
						@keyup.enter="createArticle(type)"
					/>
					<button class="button button-primary" :disabled="saving === type" @click="createArticle(type)">Добавить</button>
				</div>
				<div class="article-list">
					<div v-for="article in groups[type]" :key="article.name" class="article-row" :class="{ inactive: !article.active }">
						<div class="article-name">
							<input
								v-if="!article.system_article"
								v-model="article.article_name"
								:disabled="saving === article.name"
								@change="saveArticle(article)"
							/>
							<strong v-else>{{ article.article_name }}</strong>
							<small>ID: {{ article.name }}</small>
						</div>
						<span v-if="article.system_article" class="system-badge">Системная</span>
						<div v-else class="article-actions">
							<label title="Активна">
								<input v-model="article.active" type="checkbox" :true-value="1" :false-value="0" @change="saveArticle(article)" />
							</label>
							<button type="button" title="Удалить" :disabled="saving === article.name" @click="removeArticle(article)">×</button>
						</div>
					</div>
					<div v-if="!groups[type].length" class="empty-articles">Статей пока нет</div>
				</div>
			</article>
		</div>
		<p v-if="error" class="form-error">{{ error }}</p>
	</section>
</template>

<style scoped>
.bank-settings-link { display:flex; align-items:center; justify-content:space-between; gap:20px; margin-bottom:18px; padding:16px 18px; border:1px solid var(--border); border-radius:14px; background:var(--surface); color:var(--ink); text-decoration:none; }
.bank-settings-link div { display:grid; gap:3px; }
.bank-settings-link small { color:var(--muted); font-size:10px; font-weight:700; letter-spacing:.08em; }
.bank-settings-link span { color:var(--muted); font-size:13px; }
.bank-settings-link b { color:var(--green-dark); white-space:nowrap; }
.settings-intro {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 20px;
	margin-bottom: 18px;
	padding: 16px 18px;
	border: 1px solid var(--border);
	border-radius: 14px;
	background: var(--surface);
}
.settings-intro div { display: grid; gap: 3px; }
.settings-intro strong { font-size: 16px; }
.settings-intro span { color: var(--muted); font-size: 13px; }
.system-hint { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.system-hint i { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
.article-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.article-panel {
	overflow: hidden;
	border: 1px solid var(--border);
	border-radius: 16px;
	background: var(--surface);
}
.article-panel > header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 18px;
	border-bottom: 1px solid var(--border);
}
.article-panel header div { display: grid; gap: 3px; }
.article-panel header small { color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .08em; }
.article-panel h2 { margin: 0; font-size: 18px; }
.article-panel header > span {
	min-width: 30px;
	padding: 5px 8px;
	border-radius: 999px;
	background: var(--surface-subtle);
	text-align: center;
	font-size: 12px;
	font-weight: 700;
}
.article-create { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border); }
.article-create input, .article-name input { width: 100%; }
.article-list { display: grid; }
.article-row {
	display: flex;
	align-items: center;
	gap: 12px;
	min-height: 58px;
	padding: 9px 12px;
	border-bottom: 1px solid var(--border);
}
.article-row:last-child { border-bottom: 0; }
.article-row.inactive { opacity: .55; }
.article-name { display: grid; flex: 1; gap: 3px; min-width: 0; }
.article-name strong { font-size: 14px; }
.article-name small { overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.system-badge {
	padding: 4px 7px;
	border-radius: 999px;
	background: color-mix(in srgb, var(--green) 12%, transparent);
	color: var(--green-dark);
	font-size: 10px;
	font-weight: 700;
}
.article-actions { display: flex; align-items: center; gap: 8px; }
.article-actions button {
	width: 28px;
	height: 28px;
	border: 0;
	border-radius: 8px;
	background: transparent;
	color: var(--danger);
	font-size: 20px;
	cursor: pointer;
}
.empty-articles { padding: 24px; color: var(--muted); text-align: center; }
@media (max-width: 900px) {
	.article-columns { grid-template-columns: 1fr; }
	.settings-intro { align-items: flex-start; flex-direction: column; }
}
</style>
