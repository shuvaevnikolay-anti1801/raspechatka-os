<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { call } from "../api";

const loading = ref(true);
const busy = ref("");
const error = ref("");
const notice = ref("");
const settings = ref({});
const form = reactive({ access_token: "" });
const preview = ref(null);
const salesSync = ref({ points: [], stats: {} });
const sourceStores = ref([]);
let statusTimer;

const status = computed(
  () =>
    ({
      Connected: { label: "Подключено", className: "connected" },
      Error: { label: "Ошибка", className: "error" },
      "Not configured": { label: "Не настроено", className: "neutral" },
    }[settings.value.status] || { label: "Не настроено", className: "neutral" })
);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [base, sales] = await Promise.all([
      call("raspechatka.api.moysklad.get_settings"),
      call("raspechatka.api.moysklad_sales.get_sales_sync_settings"),
    ]);
    applySettings(base);
    salesSync.value = sales || { points: [], stats: {} };
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
  const saved = await call(
    "raspechatka.api.moysklad.save_settings",
    {
      data: JSON.stringify({
        access_token: form.access_token,
      }),
    },
    { method: "POST" }
  );
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
      const result = await call(
        "raspechatka.api.moysklad.test_connection",
        {},
        { method: "POST" }
      );
      notice.value = `Соединение работает: ${
        result.account_name || "МойСклад"
      }`;
    } else {
      preview.value = await call(
        "raspechatka.api.moysklad.read_preview",
        {},
        { method: "POST" }
      );
      notice.value =
        "Данные прочитаны. В рабочие справочники ничего не записано";
    }
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}

async function discoverSalesSources() {
  busy.value = "discover-sales";
  error.value = "";
  try {
    const result = await call(
      "raspechatka.api.moysklad_sales.discover_sales_sources",
      {},
      { method: "POST" }
    );
    sourceStores.value = result.stores || [];
    notice.value = `Найдено точек продаж: ${sourceStores.value.length}`;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}

async function saveSalesSettings() {
  busy.value = "save-sales";
  error.value = "";
  notice.value = "";
  try {
    const stores = Object.fromEntries(
      sourceStores.value.map((item) => [item.id, item])
    );
    const data = {
      enabled: Boolean(salesSync.value.enabled),
      interval_minutes: Number(salesSync.value.interval_minutes || 5),
      mappings: (salesSync.value.points || []).map((point) => ({
        point: point.name,
        source_id: point.moysklad_retail_store_id || "",
        source_name:
          stores[point.moysklad_retail_store_id]?.name ||
          point.moysklad_retail_store_name ||
          "",
      })),
    };
    salesSync.value = await call(
      "raspechatka.api.moysklad_sales.save_sales_sync_settings",
      {
        data: JSON.stringify(data),
      },
      { method: "POST" }
    );
    notice.value = "Настройки продаж сохранены";
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}

async function startSalesSync(full = false) {
  await saveSalesSettings();
  if (error.value) return;
  busy.value = full ? "full-sales" : "sales";
  try {
    const result = await call(
      "raspechatka.api.moysklad_sales.start_sales_sync",
      {
        full: full ? 1 : 0,
      },
      { method: "POST" }
    );
    if (!result.queued) {
      const reasons = {
        token_missing: "Сначала сохраните токен МойСклад",
        point_mapping_missing: "Сначала сопоставьте точку продаж",
        already_running: "Синхронизация уже выполняется",
      };
      throw new Error(
        reasons[result.reason] || "Не удалось запустить синхронизацию"
      );
    }
    notice.value = full
      ? "Загрузка истории с 1 июля 2026 года поставлена в очередь"
      : "Синхронизация поставлена в очередь";
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}


async function startSalesRecovery() {
  await saveSalesSettings();
  if (error.value) return;
  busy.value = "recover-sales";
  try {
    const result = await call(
      "raspechatka.api.moysklad_sales.start_sales_recovery",
      {},
      { method: "POST" }
    );
    if (!result.queued) {
      const reasons = {
        token_missing: "Сначала сохраните токен МойСклад",
        point_mapping_missing: "Сначала сопоставьте точку продаж",
        already_running: "Синхронизация уже выполняется",
      };
      throw new Error(
        reasons[result.reason] || "Не удалось запустить восстановление"
      );
    }
    notice.value =
      "Каталог и вся история с 1 июля поставлены в очередь. Чеки переносить вручную не потребуется.";
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}

async function refreshRunningSync() {
  if (!["Queued", "Running"].includes(salesSync.value.status)) return;
  try {
    salesSync.value = await call(
      "raspechatka.api.moysklad_sales.get_sales_sync_settings"
    );
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(async () => {
  await load();
  statusTimer = window.setInterval(refreshRunningSync, 5000);
});
onUnmounted(() => window.clearInterval(statusTimer));
</script>

<template>
  <section class="page moysklad-page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">ИНТЕГРАЦИИ</div>
        <h1>МойСклад</h1>
        <p>
          Каталог переносится разово, а продажи временно поступают из
          действующей кассы через МойСклад.
        </p>
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
              <p>
                Токен хранится в зашифрованном поле и не показывается после
                сохранения.
              </p>
            </div>
          </div>

          <label class="field-label" for="moysklad-token">Токен доступа</label>
          <input
            id="moysklad-token"
            v-model="form.access_token"
            type="password"
            autocomplete="new-password"
            :placeholder="
              settings.has_token
                ? 'Токен сохранён — оставьте пустым, чтобы не менять'
                : 'Вставьте токен МоегоСклада'
            "
          />
          <p class="field-hint">API: {{ settings.api_base }}</p>

          <p class="field-hint">
            Справочники переносятся отдельно и только по явному разовому
            запуску.
          </p>

          <div class="button-row">
            <button
              class="button"
              :disabled="Boolean(busy)"
              @click="save().catch((e) => (error = e.message))"
            >
              Сохранить
            </button>
            <button
              class="button"
              :disabled="Boolean(busy)"
              @click="run('test')"
            >
              {{ busy === "test" ? "Проверяем…" : "Проверить связь" }}
            </button>
            <button
              class="button button-primary"
              :disabled="Boolean(busy)"
              @click="run('preview')"
            >
              {{ busy === "preview" ? "Читаем…" : "Прочитать данные" }}
            </button>
          </div>
        </article>

        <aside class="safety-card">
          <div class="safety-icon">0</div>
          <h2>Изменений справочников</h2>
          <p>
            Предварительный просмотр не записывает данные. Загрузка продаж
            управляется отдельно в блоке ниже.
          </p>
          <dl>
            <div>
              <dt>Учётная запись</dt>
              <dd>{{ settings.account_name || "—" }}</dd>
            </div>
            <div>
              <dt>Последнее чтение</dt>
              <dd>{{ settings.last_checked_at || "—" }}</dd>
            </div>
          </dl>
          <p v-if="settings.last_error" class="last-error">
            {{ settings.last_error }}
          </p>
        </aside>
      </div>

      <article class="preview-card sales-sync-card">
        <div class="card-heading">
          <div>
            <h2>Продажи действующей кассы</h2>
            <p>
              История загружается с 1 июля 2026 года. Импортированные чеки не
              списывают остатки повторно.
            </p>
          </div>
          <span
            class="connection-status"
            :class="{
              connected: salesSync.status === 'Completed',
              error: salesSync.status === 'Error',
            }"
          >
            <span></span>{{ salesSync.status || "Idle" }}
          </span>
        </div>

        <div class="sales-settings">
          <label class="switch-row">
            <input v-model="salesSync.enabled" type="checkbox" />
            <span
              ><strong>Автоматическая синхронизация</strong
              ><small
                >Проверять новые и изменённые операции каждые несколько
                минут.</small
              ></span
            >
          </label>
          <label>
            <span class="field-label">Интервал, минут</span>
            <select v-model="salesSync.interval_minutes">
              <option :value="5">5</option>
              <option :value="15">15</option>
              <option :value="30">30</option>
              <option :value="60">60</option>
            </select>
          </label>
          <label>
            <span class="field-label">Начало истории</span>
            <input type="text" value="01.07.2026" disabled />
          </label>
        </div>

        <div class="mapping-heading">
          <div>
            <strong>Сопоставление точек</strong
            ><small
              >Укажите, какой точке Распечатка OS соответствует касса
              МойСклада.</small
            >
          </div>
          <button
            class="button"
            :disabled="Boolean(busy)"
            @click="discoverSalesSources"
          >
            {{
              busy === "discover-sales"
                ? "Получаем…"
                : "Получить точки МойСклада"
            }}
          </button>
        </div>
        <div class="mapping-list">
          <div
            v-for="point in salesSync.points"
            :key="point.name"
            class="mapping-row"
          >
            <div>
              <strong>{{ point.point_name }}</strong
              ><small>{{ point.city || "Город не указан" }}</small>
            </div>
            <span>→</span>
            <select v-model="point.moysklad_retail_store_id">
              <option value="">Не сопоставлена</option>
              <option
                v-if="
                  point.moysklad_retail_store_id &&
                  !sourceStores.some(
                    (item) => item.id === point.moysklad_retail_store_id
                  )
                "
                :value="point.moysklad_retail_store_id"
              >
                {{ point.moysklad_retail_store_name }}
              </option>
              <option
                v-for="store in sourceStores"
                :key="store.id"
                :value="store.id"
                :disabled="store.archived"
              >
                {{ store.name }}{{ store.archived ? " — архив" : "" }}
              </option>
            </select>
          </div>
        </div>

        <div class="button-row">
          <button
            class="button"
            :disabled="Boolean(busy)"
            @click="saveSalesSettings"
          >
            Сохранить
          </button>
          <button
            class="button"
            :disabled="Boolean(busy)"
            @click="startSalesSync(false)"
          >
            Синхронизировать сейчас
          </button>
          <button
            class="button button-primary"
            :disabled="Boolean(busy)"
            @click="startSalesSync(true)"
          >
            {{
              busy === "full-sales"
                ? "Запускаем…"
                : "Загрузить историю с 1 июля"
            }}
          </button>
          <button
            class="button"
            :disabled="Boolean(busy)"
            @click="startSalesRecovery"
          >
            {{
              busy === "recover-sales"
                ? "Восстанавливаем…"
                : "Восстановить каталог и историю"
            }}
          </button>
        </div>

        <dl class="sync-summary">
          <div>
            <dt>Последняя синхронизация</dt>
            <dd>{{ salesSync.last_sync_at || "—" }}</dd>
          </div>
          <div>
            <dt>Обработано</dt>
            <dd>{{ salesSync.stats?.processed || 0 }}</dd>
          </div>
          <div>
            <dt>Создано продаж</dt>
            <dd>{{ salesSync.stats?.sales_created || 0 }}</dd>
          </div>
          <div>
            <dt>Ошибок</dt>
            <dd>{{ salesSync.stats?.failed || 0 }}</dd>
          </div>
        </dl>

        <p class="field-hint recovery-hint">
          Если часть истории не загрузилась из-за старых связей товаров, используйте
          восстановление: система сначала приведёт каталог в соответствие, затем
          автоматически повторит импорт всей истории.
        </p>

        <p v-if="salesSync.error" class="last-error">{{ salesSync.error }}</p>
      </article>

      <article v-if="preview?.sources?.length" class="preview-card">
        <div class="card-heading">
          <div>
            <h2>Что найдено в МоёмСкладе</h2>
            <p>
              Количество и несколько примеров — без загрузки полного содержимого
              в браузер.
            </p>
          </div>
          <span class="preview-time">{{ preview.read_at }}</span>
        </div>
        <div class="source-list">
          <div
            v-for="source in preview.sources"
            :key="source.code"
            class="source-row"
          >
            <div>
              <strong>{{ source.label }}</strong>
              <small>Будет сопоставлено: {{ source.target }}</small>
            </div>
            <div class="source-samples">
              {{
                source.samples?.join(" · ") || source.error || "Нет примеров"
              }}
            </div>
            <div
              class="source-count"
              :class="{ unavailable: !source.available }"
            >
              {{ source.available ? source.count : "—" }}
            </div>
          </div>
        </div>
      </article>
    </template>
  </section>
</template>

<style scoped>
.moysklad-page {
  max-width: 1240px;
}
.connection-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 13px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 650;
  background: #f2f4f1;
  color: #657064;
}
.connection-status span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
.connection-status.connected {
  background: #edf7d9;
  color: #587d0a;
}
.connection-status.error {
  background: #fff0ed;
  color: #b7422e;
}
.success-message {
  margin: 0 0 18px;
  padding: 12px 15px;
  border: 1px solid #d9eab8;
  border-radius: 10px;
  background: #f5faeb;
  color: #496c08;
}
.integration-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(280px, 0.75fr);
  gap: 20px;
  align-items: start;
}
.settings-card,
.safety-card,
.preview-card {
  border: 1px solid #e6e9e3;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 8px 28px rgba(36, 49, 31, 0.05);
}
.settings-card,
.safety-card {
  padding: 24px;
}
.card-heading {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: start;
  margin-bottom: 22px;
}
.card-heading h2,
.safety-card h2 {
  margin: 0 0 5px;
  font-size: 18px;
}
.card-heading p,
.safety-card p {
  margin: 0;
  color: #737a70;
  line-height: 1.55;
}
.field-label {
  display: block;
  margin: 17px 0 7px;
  font-size: 13px;
  font-weight: 650;
  color: #424940;
}
input[type="password"],
select {
  width: 100%;
  min-height: 42px;
  border: 1px solid #d9ddd5;
  border-radius: 9px;
  padding: 0 12px;
  background: #fff;
  color: #252a24;
}
input[type="text"] {
  width: 100%;
  min-height: 42px;
  border: 1px solid #d9ddd5;
  border-radius: 9px;
  padding: 0 12px;
  background: #f4f5f2;
  color: #697067;
}
.field-hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: #899087;
}
.switch-row {
  display: flex;
  gap: 11px;
  align-items: flex-start;
  margin: 22px 0 4px;
  padding: 15px;
  border-radius: 11px;
  background: #f6f8f4;
  cursor: pointer;
}
.switch-row input {
  margin-top: 3px;
  accent-color: var(--green);
}
.switch-row strong,
.switch-row small {
  display: block;
}
.switch-row small {
  margin-top: 3px;
  color: #777f74;
}
.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 24px;
}
.safety-card {
  background: linear-gradient(145deg, #fbfdf7, #f3f8e8);
}
.safety-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  margin-bottom: 17px;
  border-radius: 14px;
  background: var(--green);
  color: white;
  font-size: 22px;
  font-weight: 750;
}
.safety-card dl {
  margin: 22px 0 0;
}
.safety-card dl div {
  padding: 12px 0;
  border-top: 1px solid #dfe7d3;
}
.safety-card dt {
  font-size: 12px;
  color: #7a8276;
}
.safety-card dd {
  margin: 4px 0 0;
  font-size: 13px;
  word-break: break-word;
}
.last-error {
  margin-top: 14px !important;
  color: #b7422e !important;
  font-size: 13px;
}
.preview-card {
  margin-top: 20px;
  padding: 24px;
}
.sales-settings {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) 180px 180px;
  gap: 16px;
  align-items: end;
}
.sales-settings .switch-row {
  margin: 0;
}
.mapping-heading {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: center;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid #edf0ea;
}
.mapping-heading strong,
.mapping-heading small,
.mapping-row strong,
.mapping-row small {
  display: block;
}
.mapping-heading small,
.mapping-row small {
  margin-top: 3px;
  color: #858c82;
}
.mapping-list {
  margin-top: 12px;
  border: 1px solid #e6e9e3;
  border-radius: 11px;
}
.mapping-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 24px minmax(240px, 1fr);
  gap: 14px;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid #edf0ea;
}
.mapping-row:last-child {
  border-bottom: 0;
}
.mapping-row > span {
  color: #92988f;
  text-align: center;
}
.sync-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 22px 0 0;
  border-top: 1px solid #edf0ea;
}
.sync-summary div {
  padding: 14px 12px 0 0;
}
.sync-summary dt {
  color: #858c82;
  font-size: 12px;
}
.sync-summary dd {
  margin: 4px 0 0;
  font-weight: 650;
}
.recovery-hint {
  margin: 18px 0 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: #f6f8f4;
  color: #657064;
  line-height: 1.5;
}

.preview-time {
  font-size: 12px;
  color: #8a9187;
}
.source-list {
  border-top: 1px solid #edf0ea;
}
.source-row {
  display: grid;
  grid-template-columns: minmax(190px, 0.9fr) minmax(220px, 1.5fr) 70px;
  gap: 18px;
  align-items: center;
  padding: 15px 3px;
  border-bottom: 1px solid #edf0ea;
}
.source-row strong,
.source-row small {
  display: block;
}
.source-row small {
  margin-top: 3px;
  color: #858c82;
}
.source-samples {
  overflow: hidden;
  color: #636a60;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-count {
  justify-self: end;
  min-width: 44px;
  padding: 6px 9px;
  border-radius: 8px;
  background: #eef6dc;
  color: #54760d;
  font-weight: 700;
  text-align: center;
}
.source-count.unavailable {
  background: #f3f3f1;
  color: #999e96;
}
@media (max-width: 900px) {
  .integration-grid,
  .sales-settings {
    grid-template-columns: 1fr;
  }
  .sync-summary {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 680px) {
  .source-row {
    grid-template-columns: 1fr auto;
  }
  .source-samples {
    grid-column: 1 / -1;
    grid-row: 2;
    white-space: normal;
  }
  .button-row .button {
    flex: 1 1 100%;
  }
}
</style>
