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
const stockHistory = ref({ preview: null });
const sourceStores = ref([]);
const openingStock = ref({ warehouses: [], documents: [] });
const stockSources = ref([]);
let statusTimer;

const stockHistoryErrors = computed(() =>
  (stockHistory.value.stats?.errors || []).slice(0, 50)
);

function stockHistoryErrorReason(message) {
  const value = String(message || "Неизвестная ошибка");
  if (/negative|отрицатель|недостаточ|остат/i.test(value)) {
    return "Недостаточный или отрицательный остаток";
  }
  if (/не сопостав|not mapped|catalog item|позици.*мойсклад/i.test(value)) {
    return "Не сопоставлен товар";
  }
  if (/склад|warehouse|store/i.test(value)) {
    return "Не сопоставлен или недоступен склад";
  }
  if (/поставщик|supplier|counterparty/i.test(value)) {
    return "Не сопоставлен поставщик";
  }
  if (/duplicate|unique|дубликат/i.test(value)) {
    return "Конфликт дубликатов";
  }
  if (/mandatory|required|обязатель/i.test(value)) {
    return "Не заполнено обязательное поле";
  }
  return value;
}

const stockHistoryFailureSummary = computed(() => {
  const counts = new Map();
  for (const row of stockHistoryErrors.value) {
    const reason = stockHistoryErrorReason(row.error);
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count);
});

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
    const [base, sales, stock, history] = await Promise.all([
      call("raspechatka.api.moysklad.get_settings"),
      call("raspechatka.api.moysklad_sales.get_sales_sync_settings"),
      call("raspechatka.api.moysklad_stock.get_opening_stock_settings"),
      call("raspechatka.api.moysklad_stock_history.get_stock_history_settings"),
    ]);
    applySettings(base);
    salesSync.value = sales || { points: [], stats: {} };
    openingStock.value = stock || { warehouses: [], documents: [] };
    stockHistory.value = history || { preview: null };
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

async function discoverStockSources() {
  busy.value = "discover-stock";
  error.value = "";
  notice.value = "";
  try {
    const result = await call(
      "raspechatka.api.moysklad_stock.discover_stock_sources",
      {},
      { method: "POST" }
    );
    stockSources.value = result.stores || [];
    notice.value = `Найдено складов МоегоСклада: ${stockSources.value.length}`;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}

async function saveStockMappings() {
  busy.value = "save-stock";
  error.value = "";
  notice.value = "";
  try {
    const sources = Object.fromEntries(
      stockSources.value.map((item) => [item.id, item])
    );
    openingStock.value = await call(
      "raspechatka.api.moysklad_stock.save_stock_mappings",
      {
        data: JSON.stringify({
          mappings: (openingStock.value.warehouses || []).map((warehouse) => ({
            warehouse: warehouse.name,
            source_id: warehouse.moysklad_store_id || "",
            source_name:
              sources[warehouse.moysklad_store_id]?.name ||
              warehouse.moysklad_store_name ||
              "",
          })),
        }),
      },
      { method: "POST" }
    );
    notice.value = "Сопоставление складов сохранено";
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}

async function previewOpeningStock() {
  await saveStockMappings();
  if (error.value) return;
  busy.value = "preview-stock";
  try {
    const result = await call(
      "raspechatka.api.moysklad_stock.preview_opening_stock",
      {},
      { method: "POST" }
    );
    openingStock.value = {
      ...openingStock.value,
      status: "Previewed",
      preview_token: result.preview_token,
      preview: result,
    };
    notice.value = `Проверено позиций: ${result.line_count}. Данные ещё не записаны.`;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}

async function importOpeningStock() {
  if (!openingStock.value.preview_token) return;
  if (!window.confirm("Провести проверенные начальные остатки? Повторный импорт будет запрещён.")) return;
  busy.value = "import-stock";
  error.value = "";
  notice.value = "";
  try {
    const result = await call(
      "raspechatka.api.moysklad_stock.import_opening_stock",
      { preview_token: openingStock.value.preview_token },
      { method: "POST" }
    );
    notice.value = result.duplicate
      ? "Начальные остатки уже были перенесены"
      : `Создано инвентаризаций: ${result.documents.length}`;
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}

async function auditStockHistory() {
  busy.value = "audit-stock-history";
  error.value = "";
  notice.value = "";
  try {
    const result = await call(
      "raspechatka.api.moysklad_stock_history.audit_stock_history",
      {},
      { method: "POST" }
    );
    stockHistory.value = {
      ...stockHistory.value,
      status: "Audited",
      last_audit_at: result.audited_at,
      preview: result,
    };
    notice.value = `Проверено складских документов: ${result.totals?.documents || 0}. Рабочие данные не изменялись.`;
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}

async function startStockHistoryImport() {
  if (!window.confirm("Перенести складскую историю с 1 июля и создать движения для уже загруженных продаж?")) return;
  busy.value = "import-stock-history";
  error.value = "";
  notice.value = "";
  try {
    const result = await call("raspechatka.api.moysklad_stock_history.start_stock_history_import", {}, { method: "POST" });
    if (!result.queued) {
      const reasons = {
        token_missing: "Сначала сохраните токен МоегоСклада",
        already_running: "Перенос уже выполняется",
      };
      throw new Error(reasons[result.reason] || "Не удалось запустить перенос");
    }
    stockHistory.value.status = "Running";
    notice.value = "Складская история поставлена в очередь";
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}

async function refreshRunningSync() {
  try {
    if (["Queued", "Running"].includes(salesSync.value.status)) {
      salesSync.value = await call(
        "raspechatka.api.moysklad_sales.get_sales_sync_settings"
      );
    }
    if (stockHistory.value.status === "Running") {
      stockHistory.value = await call(
        "raspechatka.api.moysklad_stock_history.get_stock_history_settings"
      );
    }
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
        <section
          v-if="salesSync.failure_summary?.length"
          class="failure-summary"
        >
          <h3>Что ещё не удалось перенести</h3>
          <p>
            Это сводка причин, а не список чеков. После следующего
            восстановления она покажет, что система обработала автоматически.
          </p>
          <div class="failure-summary-list">
            <div
              v-for="reason in salesSync.failure_summary"
              :key="reason.key"
              class="failure-summary-row"
            >
              <span>{{ reason.label }}</span>
              <strong>{{ reason.count }}</strong>
              <div
                v-if="reason.details?.length"
                class="failure-detail-list"
              >
                <div
                  v-for="detail in reason.details"
                  :key="detail.label"
                  class="failure-detail-row"
                >
                  <span>{{ detail.label }}</span>
                  <strong>{{ detail.count }}</strong>
                </div>
              </div>
            </div>
          </div>
        </section>

        <p v-if="salesSync.error" class="last-error">{{ salesSync.error }}</p>
      </article>

      <article class="preview-card sales-sync-card">
        <div class="card-heading">
          <div>
            <h2>Складская история МоегоСклада</h2>
            <p>
              Проверка всех движений с 1 июля 2026 года перед переносом истории.
            </p>
          </div>
          <span
            class="connection-status"
            :class="{
              connected: stockHistory.status === 'Audited',
              error: stockHistory.status === 'Error',
            }"
          >
            <span></span>{{ stockHistory.status || "Idle" }}
          </span>
        </div>

        <div class="button-row">
          <button
            class="button button-primary"
            :disabled="Boolean(busy)"
            @click="auditStockHistory"
          >
            {{
              busy === "audit-stock-history"
                ? "Проверяем документы…"
                : "Проверить складскую историю"
            }}
          </button>
          <button
            v-if="stockHistory.preview"
            class="button"
            :disabled="Boolean(busy) || stockHistory.status === 'Running'"
            @click="startStockHistoryImport"
          >
            {{
              stockHistory.status === "Running"
                ? "Перенос выполняется…"
                : "Перенести историю и движения продаж"
            }}
          </button>
        </div>
        <p class="field-hint">
          Проверка ничего не создаёт и не проводит. Она определяет фактический
          состав истории и готовность сопоставлений.
        </p>

        <template v-if="stockHistory.preview">
          <dl class="sync-summary">
            <div>
              <dt>Документов</dt>
              <dd>{{ stockHistory.preview.totals?.documents || 0 }}</dd>
            </div>
            <div>
              <dt>Товарных строк</dt>
              <dd>{{ stockHistory.preview.totals?.positions || 0 }}</dd>
            </div>
            <div>
              <dt>Сопоставлен склад</dt>
              <dd>
                {{ stockHistory.preview.totals?.mapped_store_documents || 0 }}
              </dd>
            </div>
            <div>
              <dt>Требуют сопоставления</dt>
              <dd>
                {{
                  (stockHistory.preview.totals?.unmapped_store_documents ||
                    0) +
                  (stockHistory.preview.totals?.missing_store_documents || 0)
                }}
              </dd>
            </div>
          </dl>
          <div class="source-list">
            <div
              v-for="source in stockHistory.preview.documents"
              :key="source.key"
              class="source-row"
            >
              <div>
                <strong>{{ source.label }}</strong>
                <small v-if="!source.available">{{ source.error }}</small>
                <small v-else
                  >{{ source.positions }} строк ·
                  {{ source.not_applicable }} не проведено</small
                >
              </div>
              <strong>{{ source.documents }}</strong>
            </div>
          </div>
        </template>
        <dl v-if="stockHistory.stats?.processed" class="sync-summary">
          <div><dt>Обработано</dt><dd>{{ stockHistory.stats.processed || 0 }}</dd></div>
          <div><dt>Приёмок</dt><dd>{{ stockHistory.stats.supply_created || 0 }}</dd></div>
          <div><dt>Оприходований</dt><dd>{{ stockHistory.stats.enter_created || 0 }}</dd></div>
          <div><dt>Списаний</dt><dd>{{ stockHistory.stats.loss_created || 0 }}</dd></div>
          <div><dt>Движений продаж</dt><dd>{{ stockHistory.stats.sales_stock_created || 0 }}</dd></div>
          <div><dt>Движений возвратов</dt><dd>{{ stockHistory.stats.return_stock_created || 0 }}</dd></div>
          <div><dt>Ошибок</dt><dd>{{ stockHistory.stats.failed || 0 }}</dd></div>
        </dl>
        <section v-if="stockHistoryErrors.length" class="stock-history-errors">
          <h3>Ошибки первоначального переноса</h3>
          <p>
            Показаны {{ stockHistoryErrors.length }} сохранённых примеров из
            {{ stockHistory.stats.failed || stockHistoryErrors.length }} ошибок.
            Повторный импорт для просмотра не запускается.
          </p>
          <div class="stock-history-error-summary">
            <div
              v-for="item in stockHistoryFailureSummary"
              :key="item.reason"
              class="stock-history-error-reason"
            >
              <span>{{ item.reason }}</span><strong>{{ item.count }}</strong>
            </div>
          </div>
          <div class="stock-history-error-list">
            <div
              v-for="(item, index) in stockHistoryErrors"
              :key="`${item.type}-${item.id}-${index}`"
              class="stock-history-error-row"
            >
              <div>
                <span class="stock-history-error-type">{{ item.type || "—" }}</span>
                <code>{{ item.id || "—" }}</code>
              </div>
              <p>{{ item.error || "Неизвестная ошибка" }}</p>
            </div>
          </div>
        </section>
        <p v-if="stockHistory.error" class="last-error">{{ stockHistory.error }}</p>
      </article>

      <article class="preview-card sales-sync-card">
        <div class="card-heading">
          <div>
            <h2>Начальные остатки</h2>
            <p>
              Одноразовый перенос фактического количества и себестоимости.
              Сначала выполняется проверка, затем отдельное подтверждение.
            </p>
          </div>
          <span class="connection-status" :class="{ connected: openingStock.status === 'Imported', error: openingStock.status === 'Error' }">
            <span></span>{{ openingStock.status || "Idle" }}
          </span>
        </div>

        <div class="mapping-heading">
          <div>
            <strong>Сопоставление складов</strong>
            <small>Каждый склад ОС должен соответствовать одному складу МоегоСклада.</small>
          </div>
          <button class="button" :disabled="Boolean(busy) || openingStock.status === 'Imported'" @click="discoverStockSources">
            {{ busy === "discover-stock" ? "Получаем…" : "Получить склады МоегоСклада" }}
          </button>
        </div>
        <div class="mapping-list">
          <div v-for="warehouse in openingStock.warehouses" :key="warehouse.name" class="mapping-row">
            <div>
              <strong>{{ warehouse.warehouse_name }}</strong>
              <small>{{ warehouse.business_point }}</small>
            </div>
            <span>→</span>
            <select v-model="warehouse.moysklad_store_id" :disabled="openingStock.status === 'Imported'">
              <option value="">Не сопоставлен</option>
              <option
                v-if="warehouse.moysklad_store_id && !stockSources.some((item) => item.id === warehouse.moysklad_store_id)"
                :value="warehouse.moysklad_store_id"
              >
                {{ warehouse.moysklad_store_name }}
              </option>
              <option v-for="store in stockSources" :key="store.id" :value="store.id" :disabled="store.archived">
                {{ store.name }}{{ store.archived ? " — архив" : "" }}
              </option>
            </select>
          </div>
        </div>

        <div class="button-row">
          <button class="button" :disabled="Boolean(busy) || openingStock.status === 'Imported'" @click="saveStockMappings">
            Сохранить сопоставление
          </button>
          <button class="button" :disabled="Boolean(busy) || openingStock.status === 'Imported'" @click="previewOpeningStock">
            {{ busy === "preview-stock" ? "Проверяем…" : "Проверить остатки" }}
          </button>
          <button class="button button-primary" :disabled="Boolean(busy) || openingStock.status !== 'Previewed'" @click="importOpeningStock">
            {{ busy === "import-stock" ? "Проводим…" : "Перенести проверенные остатки" }}
          </button>
        </div>

        <dl v-if="openingStock.preview" class="sync-summary">
          <div><dt>Складов</dt><dd>{{ openingStock.preview.warehouse_count || 0 }}</dd></div>
          <div><dt>Позиций</dt><dd>{{ openingStock.preview.line_count || 0 }}</dd></div>
          <div><dt>Количество</dt><dd>{{ openingStock.preview.total_quantity || 0 }}</dd></div>
          <div><dt>Стоимость</dt><dd>{{ openingStock.preview.total_value || 0 }} ₽</dd></div>
        </dl>
        <p v-if="openingStock.imported_at" class="field-hint">Перенесено: {{ openingStock.imported_at }}</p>
        <p v-if="openingStock.error" class="last-error">{{ openingStock.error }}</p>
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
.failure-summary {
  margin-top: 18px;
  padding: 16px;
  border: 1px solid #f0dfbb;
  border-radius: 11px;
  background: #fffbf2;
}
.failure-summary h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.failure-summary p {
  margin: 0;
  color: #746b57;
  font-size: 13px;
  line-height: 1.5;
}
.failure-summary-list {
  margin-top: 12px;
  border-top: 1px solid #f0e5cc;
}
.failure-summary-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px 16px;
  padding: 9px 0;
  border-bottom: 1px solid #f0e5cc;
  color: #5f594c;
  font-size: 13px;
}
.failure-summary-row > strong,
.failure-detail-row strong {
  color: #9a6e1f;
}
.failure-detail-list {
  grid-column: 1 / -1;
  padding: 2px 0 2px 12px;
  border-left: 2px solid #ead7aa;
}
.failure-detail-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  padding: 4px 0;
  color: #746b57;
  font-size: 12px;
}
.stock-history-errors {
  margin-top: 20px;
  padding: 18px;
  border: 1px solid #efc9c1;
  border-radius: 11px;
  background: #fff8f6;
}
.stock-history-errors h3 {
  margin: 0 0 5px;
  font-size: 15px;
}
.stock-history-errors > p {
  margin: 0;
  color: #78615c;
  font-size: 13px;
  line-height: 1.5;
}
.stock-history-error-summary {
  margin-top: 14px;
  border-top: 1px solid #efd8d3;
}
.stock-history-error-reason {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  padding: 9px 0;
  border-bottom: 1px solid #efd8d3;
  font-size: 13px;
}
.stock-history-error-reason strong {
  color: #ad4937;
}
.stock-history-error-list {
  max-height: 520px;
  margin-top: 16px;
  overflow: auto;
  border: 1px solid #efd8d3;
  border-radius: 9px;
  background: #fff;
}
.stock-history-error-row {
  padding: 11px 13px;
  border-bottom: 1px solid #f2e3df;
}
.stock-history-error-row:last-child {
  border-bottom: 0;
}
.stock-history-error-row > div {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.stock-history-error-type {
  padding: 3px 7px;
  border-radius: 999px;
  background: #f8dfd9;
  color: #9d3f2e;
  font-size: 11px;
  font-weight: 700;
}
.stock-history-error-row code {
  color: #766b68;
  font-size: 11px;
  word-break: break-all;
}
.stock-history-error-row p {
  margin: 7px 0 0;
  color: #493f3c;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
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
