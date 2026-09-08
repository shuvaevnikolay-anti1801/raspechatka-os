<script setup>
import { onMounted, reactive, ref, watch } from "vue";
import { call } from "../api";

const props = defineProps({
  businessPoint: { type: String, required: true },
  compact: { type: Boolean, default: false },
});

const loading = ref(false);
const savingPolicy = ref(false);
const seeding = ref(false);
const error = ref("");
const notice = ref("");
const components = ref([]);
const policy = reactive({
  business_point: "",
  ndfl_rate: 13,
  insurance_rate: 30,
  injury_rate: 0.2,
  annual_leave_days: 28,
  first_half_pay_day: 20,
  second_half_pay_day: 5,
  active: 1,
});
const draft = reactive(emptyComponent());

function emptyComponent() {
  return {
    name: "",
    business_point: props.businessPoint || "",
    component_code: "",
    component_name: "",
    active: 1,
    calculation_basis: "Hours",
    default_rate: 0,
    default_percent: 0,
    payment_method: "Bank Transfer",
    include_in_ndfl_base: 1,
    include_in_insurance_base: 1,
    include_in_injury_base: 1,
    exemption_basis: "",
    notes: "",
  };
}

function resetDraft(values = null) {
  Object.keys(draft).forEach((key) => delete draft[key]);
  Object.assign(draft, values ? JSON.parse(JSON.stringify(values)) : emptyComponent(), {
    business_point: props.businessPoint,
  });
}

async function load() {
  if (!props.businessPoint) return;
  loading.value = true;
  error.value = "";
  try {
    const result = await call("raspechatka.api.team.get_payroll_settings", {
      business_point: props.businessPoint,
    });
    Object.assign(policy, result.policy || {}, { business_point: props.businessPoint });
    components.value = result.components || [];
    resetDraft();
  } catch (exception) {
    error.value = exception.message;
  } finally {
    loading.value = false;
  }
}

async function savePolicy() {
  savingPolicy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await call("raspechatka.api.team.save_payroll_policy", {
      data: JSON.stringify(policy),
    }, { method: "POST" });
    notice.value = "Общие условия точки сохранены.";
    await load();
  } catch (exception) {
    error.value = exception.message;
  } finally {
    savingPolicy.value = false;
  }
}

async function saveComponent() {
  error.value = "";
  notice.value = "";
  try {
    await call("raspechatka.api.team.save_payroll_component", {
      data: JSON.stringify(draft),
    }, { method: "POST" });
    notice.value = "Вид начисления сохранён.";
    await load();
  } catch (exception) {
    error.value = exception.message;
  }
}

async function seedDefaults() {
  seeding.value = true;
  error.value = "";
  try {
    const result = await call("raspechatka.api.team.create_default_payroll_components", {
      business_point: props.businessPoint,
    }, { method: "POST" });
    notice.value = result.created
      ? `Добавлено стандартных начислений: ${result.created}.`
      : "Стандартные начисления уже созданы.";
    await load();
  } catch (exception) {
    error.value = exception.message;
  } finally {
    seeding.value = false;
  }
}

watch(() => props.businessPoint, load);
onMounted(load);
</script>

<template>
  <section class="payroll-settings-panel" :class="{ compact }">
    <div class="panel-heading">
      <div>
        <h3>Оплата труда</h3>
        <p>Правила действуют для всех сотрудников этой точки. Индивидуальные начисления оформляются при расчёте зарплаты.</p>
      </div>
      <button class="button button-secondary" type="button" :disabled="loading || seeding" @click="seedDefaults">
        {{ seeding ? "Создаём…" : "Добавить стандартные начисления" }}
      </button>
    </div>

    <p v-if="loading" class="muted-note">Загружаем настройки…</p>
    <template v-else>
      <div class="policy-grid">
        <label>НДФЛ, %<input v-model.number="policy.ndfl_rate" type="number" min="0" step="0.01" /></label>
        <label>Страховые взносы, %<input v-model.number="policy.insurance_rate" type="number" min="0" step="0.01" /></label>
        <label>Травматизм, %<input v-model.number="policy.injury_rate" type="number" min="0" step="0.01" /></label>
        <label>Отпуск по умолчанию, дней<input v-model.number="policy.annual_leave_days" type="number" min="0" step="1" /></label>
        <label>Аванс — день месяца<input v-model.number="policy.first_half_pay_day" type="number" min="1" max="31" /></label>
        <label>Зарплата — день месяца<input v-model.number="policy.second_half_pay_day" type="number" min="1" max="31" /></label>
      </div>
      <div class="policy-actions">
        <label class="check-field"><input v-model="policy.active" type="checkbox" :true-value="1" :false-value="0" /> Настройки действуют</label>
        <button class="button button-primary" type="button" :disabled="savingPolicy" @click="savePolicy">
          {{ savingPolicy ? "Сохраняем…" : "Сохранить условия точки" }}
        </button>
      </div>

      <div class="component-list">
        <article v-for="item in components" :key="item.name" :class="{ inactive: !item.active }">
          <div><b>{{ item.component_name }}</b><small>{{ item.component_code }} · {{ item.calculation_basis }}</small></div>
          <span v-if="item.calculation_basis === 'Personal Sales'">{{ item.default_percent || 0 }}%</span>
          <span v-else-if="item.calculation_basis !== 'Manual' && item.calculation_basis !== 'External Result'">{{ item.default_rate || 0 }} ₽</span>
          <span>{{ item.payment_method === "Bank Transfer" ? "На карту" : "Наличными" }}</span>
          <button class="text-button" type="button" @click="resetDraft(item)">Изменить</button>
        </article>
        <p v-if="!components.length" class="muted-note">Виды начислений ещё не настроены.</p>
      </div>

      <form class="component-editor" @submit.prevent="saveComponent">
        <h4>{{ draft.name ? "Изменить начисление" : "Добавить начисление" }}</h4>
        <div class="editor-grid">
          <label>Код<input v-model="draft.component_code" required placeholder="HOURLY" /></label>
          <label class="wide">Название<input v-model="draft.component_name" required placeholder="Оплата за часы" /></label>
          <label>Основание
            <select v-model="draft.calculation_basis">
              <option value="Hours">Отработанные часы</option>
              <option value="Personal Sales">Личная выручка</option>
              <option value="Fixed Amount">Фиксированная сумма</option>
              <option value="External Result">Премия по результату</option>
              <option value="Manual">Ручное начисление</option>
            </select>
          </label>
          <label v-if="draft.calculation_basis === 'Personal Sales'">Процент<input v-model.number="draft.default_percent" type="number" min="0" step="0.01" /></label>
          <label v-else-if="['Hours', 'Fixed Amount'].includes(draft.calculation_basis)">Ставка / сумма<input v-model.number="draft.default_rate" type="number" min="0" step="0.01" /></label>
          <label>Выплата
            <select v-model="draft.payment_method">
              <option value="Bank Transfer">На карту</option>
              <option value="Cash">Наличными</option>
            </select>
          </label>
        </div>
        <div class="tax-flags">
          <label class="check-field"><input v-model="draft.include_in_ndfl_base" type="checkbox" :true-value="1" :false-value="0" /> База НДФЛ</label>
          <label class="check-field"><input v-model="draft.include_in_insurance_base" type="checkbox" :true-value="1" :false-value="0" /> Страховые взносы</label>
          <label class="check-field"><input v-model="draft.include_in_injury_base" type="checkbox" :true-value="1" :false-value="0" /> Травматизм</label>
          <label class="check-field"><input v-model="draft.active" type="checkbox" :true-value="1" :false-value="0" /> Действует</label>
        </div>
        <label v-if="!draft.include_in_ndfl_base || !draft.include_in_insurance_base || !draft.include_in_injury_base">
          Основание исключения из налоговой базы
          <textarea v-model="draft.exemption_basis" rows="2" required placeholder="Статья закона, вид компенсации или заключение бухгалтера"></textarea>
        </label>
        <label>Комментарий<textarea v-model="draft.notes" rows="2"></textarea></label>
        <div class="editor-actions">
          <button v-if="draft.name" class="button button-secondary" type="button" @click="resetDraft()">Отмена</button>
          <button class="button button-primary" type="submit">{{ draft.name ? "Сохранить начисление" : "Добавить начисление" }}</button>
        </div>
      </form>
    </template>
    <p v-if="notice" class="form-success">{{ notice }}</p>
    <p v-if="error" class="form-error">{{ error }}</p>
  </section>
</template>

<style scoped>
.payroll-settings-panel { display: grid; gap: 22px; }
.panel-heading, .policy-actions, .editor-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.panel-heading h3, .component-editor h4 { margin: 0 0 6px; }
.panel-heading p { margin: 0; color: var(--text-muted, #667085); max-width: 760px; }
.policy-grid, .editor-grid { display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap: 14px; }
label { display: grid; gap: 6px; font-size: 13px; }
input, select, textarea { width: 100%; }
.component-list { display: grid; border: 1px solid var(--border, #dfe3e6); border-radius: 10px; overflow: hidden; }
.component-list article { display: grid; grid-template-columns: minmax(220px, 2fr) 120px 120px auto; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--border, #e7e9eb); }
.component-list article:last-child { border-bottom: 0; }
.component-list article.inactive { opacity: .55; }
.component-list article div { display: grid; gap: 3px; }
.component-list small { color: var(--text-muted, #667085); }
.component-editor { display: grid; gap: 16px; padding: 18px; background: var(--surface-soft, #f7f8f6); border-radius: 10px; }
.tax-flags { display: flex; flex-wrap: wrap; gap: 16px; }
.check-field { display: flex; align-items: center; gap: 8px; }
.check-field input { width: auto; }
.form-success { color: #38761d; margin: 0; }
.form-error { color: #b42318; margin: 0; }
@media (max-width: 900px) {
  .policy-grid, .editor-grid { grid-template-columns: 1fr 1fr; }
  .component-list article { grid-template-columns: 1fr auto; }
}
@media (max-width: 620px) {
  .panel-heading, .policy-actions { align-items: stretch; flex-direction: column; }
  .policy-grid, .editor-grid { grid-template-columns: 1fr; }
}
</style>
