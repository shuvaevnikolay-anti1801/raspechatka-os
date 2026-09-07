<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { call } from "../api";

const loading = ref(true);
const busy = ref("");
const error = ref("");
const notice = ref("");
const settings = ref({});
const form = reactive({ access_token: "" });
const preview = ref(null);

const status = computed(() => ({
  Connected: { label: "Подключено", className: "connected" },
  Error: { label: "Ошибка", className: "error" },
  "Not configured": { label: "Не настроено", className: "neutral" },
}[settings.value.status] || { label: "Не настроено", className: "neutral" }));

async function load() {
  loading.value = true;
  error.value = "";
  try {
    applySettings(await call("raspechatka.api.moysklad.get_settings"));
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function applySettings(value) {
  settings.value = value || {};
  preview.value = value?.preview || preview.value;
}

async function save(showNotice = true) {
  error.value = "";
  notice.value = "";
  const saved = await call("raspechatka.api.moysklad.save_settings", {
    data: JSON.stringify({
      access_token: form.access_token,
    }),
  }, { method: "POST" });
  form.access_token = "";
  applySettings(saved);
  if (showNotice) notice.value = "Настройки сохранены";
}

async function run(action) {
  busy.value = action;
  error.value = "";
  notice.value = "";
  try {
    await save(false);
    if (action === "test") {
      const result = await call("raspechatka.api.moysklad.test_connection", {}, { method: "POST" });
      notice.value = `Соединение работает: ${result.account_name || "МойСклад"}`;
    } else {
      preview.value = await call("raspechatka.api.moysklad.read_preview", {}, { method: "POST" });
      notice.value = "Данные прочитаны. В рабочие справочники ничего не записано";
    }
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}

onMounted(load);
</script>

<template>
  <section class="page moysklad-page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">ИНТЕГРАЦИИ</div>
        <h1>МойСклад</h1>
        <p>Однократный импорт исходных данных. После переноса система работает самостоятельно.</p>
      </div>
      <div v-if="!loading" class="connection-status" :class="status.className">
        <span></span>{{ status.label }}
      </div>
    </div>

    <div v-if="error" class="form-error">{{ error }}</div>
    <div v-if="notice" class="success-message">{{ notice }}</div>
    <div v-if="loading" class="table-message"><span class="loader"></span></div>

    <template v-else>
      <div class="integration-grid">
        <article class="settings-card">
          <div class="card-heading">
            <div>
              <h2>Подключение</h2>
              <p>Токен хранится в зашифрованном поле и не показывается после сохранения.</p>
            </div>
          </div>

          <label class="field-label" for="moysklad-token">Токен доступа</label>
          <input
            id="moysklad-token"
            v-model="form.access_token"
            type="password"
            autocomplete="new-password"
            :placeholder="settings.has_token ? 'Токен сохранён — оставьте пустым, чтобы не менять' : 'Вставьте токен МоегоСклада'"
          />
          <p class="field-hint">API: {{ settings.api_base }}</p>

          <p class="field-hint">Постоянная синхронизация выключена. Данные переносятся только по явному разовому запуску.</p>

          <div class="button-row">
            <button class="button" :disabled="Boolean(busy)" @click="save().catch((e) => error = e.message)">
              Сохранить
            </button>
            <button class="button" :disabled="Boolean(busy)" @click="run('test')">
              {{ busy === "test" ? "Проверяем…" : "Проверить связь" }}
            </button>
            <button class="button button-primary" :disabled="Boolean(busy)" @click="run('preview')">
              {{ busy === "preview" ? "Читаем…" : "Прочитать данные" }}
            </button>
          </div>
        </article>

        <aside class="safety-card">
          <div class="safety-icon">0</div>
          <h2>Записей будет изменено</h2>
          <p>Сейчас работает только предварительный просмотр. Импорт включим после согласования полей и правил устранения дублей.</p>
          <dl>
            <div><dt>Учётная запись</dt><dd>{{ settings.account_name || "—" }}</dd></div>
            <div><dt>Последнее чтение</dt><dd>{{ settings.last_checked_at || "—" }}</dd></div>
          </dl>
          <p v-if="settings.last_error" class="last-error">{{ settings.last_error }}</p>
        </aside>
      </div>

      <article v-if="preview?.sources?.length" class="preview-card">
        <div class="card-heading">
          <div>
            <h2>Что найдено в МоёмСкладе</h2>
            <p>Количество и несколько примеров — без загрузки полного содержимого в браузер.</p>
          </div>
          <span class="preview-time">{{ preview.read_at }}</span>
        </div>
        <div class="source-list">
          <div v-for="source in preview.sources" :key="source.code" class="source-row">
            <div>
              <strong>{{ source.label }}</strong>
              <small>Будет сопоставлено: {{ source.target }}</small>
            </div>
            <div class="source-samples">{{ source.samples?.join(" · ") || source.error || "Нет примеров" }}</div>
            <div class="source-count" :class="{ unavailable: !source.available }">
              {{ source.available ? source.count : "—" }}
            </div>
          </div>
        </div>
      </article>
    </template>
  </section>
</template>

<style scoped>
.moysklad-page { max-width: 1240px; }
.connection-status { display: inline-flex; align-items: center; gap: 8px; padding: 9px 13px; border-radius: 999px; font-size: 13px; font-weight: 650; background: #f2f4f1; color: #657064; }
.connection-status span { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.connection-status.connected { background: #edf7d9; color: #587d0a; }
.connection-status.error { background: #fff0ed; color: #b7422e; }
.success-message { margin: 0 0 18px; padding: 12px 15px; border: 1px solid #d9eab8; border-radius: 10px; background: #f5faeb; color: #496c08; }
.integration-grid { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(280px, .75fr); gap: 20px; align-items: start; }
.settings-card, .safety-card, .preview-card { border: 1px solid #e6e9e3; border-radius: 16px; background: #fff; box-shadow: 0 8px 28px rgba(36, 49, 31, .05); }
.settings-card, .safety-card { padding: 24px; }
.card-heading { display: flex; justify-content: space-between; gap: 20px; align-items: start; margin-bottom: 22px; }
.card-heading h2, .safety-card h2 { margin: 0 0 5px; font-size: 18px; }
.card-heading p, .safety-card p { margin: 0; color: #737a70; line-height: 1.55; }
.field-label { display: block; margin: 17px 0 7px; font-size: 13px; font-weight: 650; color: #424940; }
input[type="password"], select { width: 100%; min-height: 42px; border: 1px solid #d9ddd5; border-radius: 9px; padding: 0 12px; background: #fff; color: #252a24; }
.field-hint { margin: 6px 0 0; font-size: 12px; color: #899087; }
.switch-row { display: flex; gap: 11px; align-items: flex-start; margin: 22px 0 4px; padding: 15px; border-radius: 11px; background: #f6f8f4; cursor: pointer; }
.switch-row input { margin-top: 3px; accent-color: var(--green); }
.switch-row strong, .switch-row small { display: block; }
.switch-row small { margin-top: 3px; color: #777f74; }
.button-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
.safety-card { background: linear-gradient(145deg, #fbfdf7, #f3f8e8); }
.safety-icon { display: grid; place-items: center; width: 48px; height: 48px; margin-bottom: 17px; border-radius: 14px; background: var(--green); color: white; font-size: 22px; font-weight: 750; }
.safety-card dl { margin: 22px 0 0; }
.safety-card dl div { padding: 12px 0; border-top: 1px solid #dfe7d3; }
.safety-card dt { font-size: 12px; color: #7a8276; }
.safety-card dd { margin: 4px 0 0; font-size: 13px; word-break: break-word; }
.last-error { margin-top: 14px !important; color: #b7422e !important; font-size: 13px; }
.preview-card { margin-top: 20px; padding: 24px; }
.preview-time { font-size: 12px; color: #8a9187; }
.source-list { border-top: 1px solid #edf0ea; }
.source-row { display: grid; grid-template-columns: minmax(190px, .9fr) minmax(220px, 1.5fr) 70px; gap: 18px; align-items: center; padding: 15px 3px; border-bottom: 1px solid #edf0ea; }
.source-row strong, .source-row small { display: block; }
.source-row small { margin-top: 3px; color: #858c82; }
.source-samples { overflow: hidden; color: #636a60; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.source-count { justify-self: end; min-width: 44px; padding: 6px 9px; border-radius: 8px; background: #eef6dc; color: #54760d; font-weight: 700; text-align: center; }
.source-count.unavailable { background: #f3f3f1; color: #999e96; }
@media (max-width: 900px) { .integration-grid { grid-template-columns: 1fr; } }
@media (max-width: 680px) { .source-row { grid-template-columns: 1fr auto; } .source-samples { grid-column: 1 / -1; grid-row: 2; white-space: normal; } .button-row .button { flex: 1 1 100%; } }
</style>
