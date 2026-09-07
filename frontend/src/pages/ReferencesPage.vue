<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { call } from "../api";
import AppModal from "../components/AppModal.vue";
import ReferenceTable from "../components/ReferenceTable.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";

const route = useRoute();
const reference = computed(() => route.params.reference || "entities");
const rows = ref([]);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const formError = ref("");
const filters = ref({ search: "", active: "1" });
const detail = ref(null);
const form = reactive({});
const options = reactive({ organizations: [], entities: [], bank_accounts: [], products: [] });
const bankForm = reactive({ name: "", settlement_account: "", currency: "RUB", bic: "", bank_name: "", correspondent_account: "", bank_address: "", active: 1 });
const lookingUpInn = ref(false);
const lookingUpBic = ref(false);
const cabinetForm = reactive({ cabinet_number: "", active: 1 });
const locationForm = reactive({ cabinet: "", location_name: "", active: 1 });
const storageForm = reactive({ item: "", storage_location: "", active: 1 });

const configs = {
  entities: {
    eyebrow: "СПРАВОЧНИКИ / БИЗНЕС",
    title: "Юридические лица",
    description: "Индивидуальные предприниматели партнёров",
    create: "Добавить ИП",
    columns: [
      { key: "short_name", label: "Наименование", primary: true },
      { key: "inn", label: "ИНН" },
      { key: "organization", label: "Партнёр" },
      { key: "tax_system", label: "Налоговый режим" },
      { key: "phone", label: "Телефон", default: false },
      { key: "email", label: "E-mail", default: false },
      { key: "active", label: "Статус" },
    ],
  },
  points: {
    eyebrow: "СПРАВОЧНИКИ / СЕТЬ",
    title: "Точки продаж",
    description: "Рабочие точки, контакты, режим и правила продаж",
    create: "Добавить точку",
    columns: [
      { key: "point_name", label: "Точка продаж", primary: true },
      { key: "business_entity", label: "Юридическое лицо" },
      { key: "city", label: "Город" },
      { key: "address", label: "Адрес" },
      { key: "phone", label: "Телефон", default: false },
      { key: "email", label: "E-mail", default: false },
      { key: "warehouse", label: "Склад", default: false },
      { key: "active", label: "Статус" },
    ],
  },
  warehouses: {
    eyebrow: "СПРАВОЧНИКИ / ХРАНЕНИЕ",
    title: "Склады",
    description: "Один склад на точку, шкафы и места хранения",
    columns: [
      { key: "warehouse_name", label: "Склад", primary: true },
      { key: "business_point", label: "Точка продаж" },
      { key: "cabinet_count", label: "Шкафов" },
      { key: "active", label: "Статус" },
    ],
  },
};

const config = computed(() => configs[reference.value]);
const filterFields = computed(() => [
  { key: "search", label: "Поиск", placeholder: "Поиск по справочнику", wide: true },
  { key: "active", label: "Статус", type: "select", allLabel: "Любой статус", options: [{ value: "1", label: "Активные" }, { value: "0", label: reference.value === "entities" ? "Архивные" : "Неактивные" }] },
]);
const title = computed(() => detail.value ? (form.short_name || form.point_name || form.warehouse_name) : config.value?.create);
const entityAccounts = computed(() => options.bank_accounts.filter((account) => account.business_entity === form.business_entity));
const warehouseLocations = computed(() => (detail.value?.cabinets || []).flatMap((cabinet) => cabinet.locations || []));
const weekdayLabels = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];

function emptyHours() {
  return weekdayLabels.map((weekday, index) => ({ weekday, is_working: index < 5 ? 1 : 0, opens_at: "09:00", closes_at: "20:00" }));
}

function resetObject(target, values) {
  Object.keys(target).forEach((key) => delete target[key]);
  Object.assign(target, values);
}

function defaultFilters() {
  return { search: "", active: reference.value === "entities" ? "1" : "" };
}

async function loadRows() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await call("raspechatka.api.references.get_reference_list", { reference: reference.value, ...filters.value });
  } catch (exception) {
    error.value = exception.message;
  } finally {
    loading.value = false;
  }
}

async function loadOptions() {
  try {
    Object.assign(options, await call("raspechatka.api.references.get_reference_options"));
  } catch (exception) {
    error.value = exception.message;
  }
}

function newReference() {
  formError.value = "";
  detail.value = {};
  if (reference.value === "entities") {
    resetObject(form, { short_name: "", full_name: "", organization: options.organizations[0]?.name || "", active: 1, last_name: "", first_name: "", middle_name: "", inn: "", ogrnip: "", okpo: "", registration_address: "", registration_status: "", phone: "", email: "", tax_system: "Патент", vat_payer: 0 });
  } else {
    resetObject(form, { point_name: "", business_entity: options.entities[0]?.name || "", active: 1, city: "", address: "", phone: "", email: "", timezone: "Europe/Moscow", working_hours: emptyHours(), allow_free_price: 0, allow_discounts: 1, max_discount_percent: 100, allow_remove_cart_item: 1, accepts_cash: 1, accepts_card: 1, card_bank_account: "", accepts_qr: 1, qr_bank_account: "" });
  }
}

async function openReference(row) {
  formError.value = "";
  try {
    const result = await call("raspechatka.api.references.get_reference_detail", { reference: reference.value, name: row.name });
    detail.value = result;
    resetObject(form, JSON.parse(JSON.stringify(result)));
    resetObject(bankForm, { name: "", settlement_account: "", currency: "RUB", bic: "", bank_name: "", correspondent_account: "", bank_address: "", active: 1 });
    if (reference.value === "points" && !form.working_hours?.length) form.working_hours = emptyHours();
  } catch (exception) {
    error.value = exception.message;
  }
}

async function lookupInn() {
  formError.value = "";
  lookingUpInn.value = true;
  try {
    const result = await call("raspechatka.api.references.lookup_entity_by_inn", { inn: form.inn });
    Object.assign(form, result);
  } catch (exception) {
    formError.value = `${exception.message} Данные можно заполнить вручную.`;
  } finally {
    lookingUpInn.value = false;
  }
}

async function lookupBic() {
  formError.value = "";
  lookingUpBic.value = true;
  try {
    Object.assign(bankForm, await call("raspechatka.api.references.lookup_bank_by_bic", { bic: bankForm.bic }));
  } catch (exception) {
    formError.value = `${exception.message} Реквизиты банка можно заполнить вручную.`;
  } finally {
    lookingUpBic.value = false;
  }
}

async function saveReference() {
  saving.value = true;
  formError.value = "";
  try {
    const result = await call("raspechatka.api.references.save_reference", { reference: reference.value, data: JSON.stringify(form) }, { method: "POST" });
    await Promise.all([loadRows(), loadOptions()]);
    await openReference({ name: result.name });
  } catch (exception) {
    formError.value = exception.message;
  } finally {
    saving.value = false;
  }
}

async function setActive(value) {
  await call("raspechatka.api.references.archive_reference", { reference: reference.value, name: form.name, active: value }, { method: "POST" });
  detail.value = null;
  await loadRows();
}

async function saveBank() {
  formError.value = "";
  try {
    await call("raspechatka.api.references.save_bank_account", { data: JSON.stringify({ ...bankForm, business_entity: form.name }) }, { method: "POST" });
    resetObject(bankForm, { name: "", settlement_account: "", currency: "RUB", bic: "", bank_name: "", correspondent_account: "", bank_address: "", active: 1 });
    await Promise.all([openReference({ name: form.name }), loadOptions()]);
  } catch (exception) { formError.value = exception.message; }
}

function editBank(account) {
  resetObject(bankForm, JSON.parse(JSON.stringify(account)));
}

async function setBankActive(account, active) {
  formError.value = "";
  try {
    await call("raspechatka.api.references.save_bank_account", { data: JSON.stringify({ ...account, active }) }, { method: "POST" });
    await Promise.all([openReference({ name: form.name }), loadOptions()]);
  } catch (exception) { formError.value = exception.message; }
}

async function saveCabinet() {
  try {
    await call("raspechatka.api.references.save_cabinet", { data: JSON.stringify({ ...cabinetForm, warehouse: form.name }) }, { method: "POST" });
    resetObject(cabinetForm, { cabinet_number: "", active: 1 });
    await openReference({ name: form.name });
  } catch (exception) { formError.value = exception.message; }
}

async function saveLocation() {
  try {
    await call("raspechatka.api.references.save_storage_location", { data: JSON.stringify(locationForm) }, { method: "POST" });
    resetObject(locationForm, { cabinet: "", location_name: "", active: 1 });
    await openReference({ name: form.name });
  } catch (exception) { formError.value = exception.message; }
}

async function saveStorage() {
  try {
    await call("raspechatka.api.references.save_item_storage", { data: JSON.stringify({ ...storageForm, warehouse: form.name }) }, { method: "POST" });
    resetObject(storageForm, { item: "", storage_location: "", active: 1 });
    await openReference({ name: form.name });
  } catch (exception) { formError.value = exception.message; }
}

watch(reference, () => { filters.value = defaultFilters(); detail.value = null; loadRows(); });
onMounted(() => Promise.all([loadRows(), loadOptions()]));
</script>

<template>
  <section class="page reference-page">
    <ListPageHeader :title="config.title"><template #actions><button v-if="config.create" class="button button-primary" type="button" @click="newReference">＋ {{ config.create }}</button></template></ListPageHeader>
    <SmartFilterBar v-model="filters" :fields="filterFields" :view-key="`references.${reference}`" @apply="loadRows" @reset="loadRows" />

    <ReferenceTable :key="reference" :rows="rows" :columns="config.columns" :view-key="`references.${reference}`" :loading="loading" :error="error" @open="openReference" @retry="loadRows" />

    <AppModal v-if="detail !== null" :title="title || config.title" wide @close="detail = null">
      <form v-if="reference === 'entities'" class="editor-form" @submit.prevent="saveReference">
        <div class="form-section"><h3>Основное</h3><div class="form-grid">
          <label>Партнёр<select v-model="form.organization" required><option v-for="item in options.organizations" :key="item.name" :value="item.name">{{ item.organization_name }}</option></select></label>
          <label>Внутренний код<input :value="form.internal_code || 'Будет создан автоматически'" disabled /></label>
          <label>Краткое наименование<input v-model="form.short_name" required /></label>
          <label class="span-2">Полное наименование<input v-model="form.full_name" required /></label>
        </div></div>
        <div class="form-section"><h3>Регистрационные данные</h3><div class="form-grid">
          <label class="span-2">ИНН<div class="field-with-action"><input v-model="form.inn" inputmode="numeric" maxlength="12" required /><button class="button button-secondary" type="button" :disabled="lookingUpInn || !form.inn" @click="lookupInn">{{ lookingUpInn ? 'Ищем…' : 'Заполнить по ИНН' }}</button></div></label>
          <p class="muted-note span-3">Автозаполнение помогает внести реквизиты, но все поля можно заполнить и исправить вручную.</p>
          <label>Статус по реестру<input :value="form.registration_status || 'Не проверен'" disabled /></label>
          <label>ОГРНИП<input v-model="form.ogrnip" inputmode="numeric" maxlength="15" /></label>
          <label>ОКПО<input v-model="form.okpo" inputmode="numeric" /></label>
          <label>Фамилия<input v-model="form.last_name" required /></label><label>Имя<input v-model="form.first_name" required /></label><label>Отчество<input v-model="form.middle_name" /></label>
          <label class="span-3">Адрес регистрации<textarea v-model="form.registration_address" rows="2"></textarea></label>
        </div></div>
        <div class="form-section"><h3>Контакты</h3><div class="form-grid">
          <label>Телефон<input v-model="form.phone" /></label><label>E-mail<input v-model="form.email" type="email" /></label>
        </div></div>
        <div class="form-section"><h3>Налоги</h3><div class="form-grid">
          <label>Налоговый режим<select v-model="form.tax_system"><option>ОСНО</option><option>УСН Доход</option><option>УСН Доход минус расход</option><option>Патент</option><option>ЕСХН</option><option>АУСН</option></select></label>
          <label class="check-field"><input v-model="form.vat_payer" type="checkbox" :true-value="1" :false-value="0" /> Плательщик НДС</label>
        </div></div>
        <div v-if="form.name" class="form-section"><h3>Расчётные счета</h3>
          <div v-if="detail.bank_accounts?.length" class="compact-list bank-account-list"><div v-for="account in detail.bank_accounts" :key="account.name" :class="{ archived: !account.active }"><b>{{ account.bank_name }}</b><span>{{ account.settlement_account }}</span><small>БИК {{ account.bic }} · {{ account.active ? 'Активен' : 'В архиве' }}</small><span class="row-actions"><button class="text-button" type="button" @click="editBank(account)">Изменить</button><button class="text-button" type="button" @click="setBankActive(account, account.active ? 0 : 1)">{{ account.active ? 'В архив' : 'Восстановить' }}</button></span></div></div>
          <div class="bank-editor form-grid">
            <label>БИК<div class="field-with-action"><input v-model="bankForm.bic" inputmode="numeric" maxlength="9" /><button class="button button-secondary" type="button" :disabled="lookingUpBic || !bankForm.bic" @click="lookupBic">{{ lookingUpBic ? 'Ищем…' : 'Заполнить' }}</button></div></label>
            <label class="span-2">Банк<input v-model="bankForm.bank_name" /></label>
            <label>Расчётный счёт<input v-model="bankForm.settlement_account" inputmode="numeric" maxlength="20" /></label><label>Корреспондентский счёт<input v-model="bankForm.correspondent_account" inputmode="numeric" maxlength="20" /></label><label>Валюта<input v-model="bankForm.currency" /></label>
            <label class="span-3">Адрес банка<input v-model="bankForm.bank_address" /></label>
          </div>
          <div class="footer-actions"><button v-if="bankForm.name" class="button button-secondary" type="button" @click="resetObject(bankForm, { name: '', settlement_account: '', currency: 'RUB', bic: '', bank_name: '', correspondent_account: '', bank_address: '', active: 1 })">Отмена</button><button class="button button-secondary" type="button" @click="saveBank">{{ bankForm.name ? 'Сохранить счёт' : 'Добавить счёт' }}</button></div>
        </div>
        <p v-if="formError" class="form-error">{{ formError }}</p>
      </form>

      <form v-else-if="reference === 'points'" class="editor-form" @submit.prevent="saveReference">
        <div class="form-section"><h3>Основное</h3><div class="form-grid">
          <label class="span-2">Название точки<input v-model="form.point_name" required /></label>
          <label>Юридическое лицо<select v-model="form.business_entity" required><option v-for="item in options.entities" :key="item.name" :value="item.name">{{ item.short_name }}</option></select></label>
          <label class="check-field"><input v-model="form.active" type="checkbox" :true-value="1" :false-value="0" /> Активна</label>
        </div></div>
        <div class="form-section"><h3>Контакты</h3><div class="form-grid">
          <label>Город<input v-model="form.city" required /></label><label class="span-2">Адрес<textarea v-model="form.address" rows="2" required></textarea></label>
          <label>Телефон<input v-model="form.phone" /></label><label>E-mail<input v-model="form.email" type="email" /></label><label>Часовой пояс<input v-model="form.timezone" /></label>
        </div></div>
        <div class="form-section"><h3>Режим работы</h3><div class="hours-list"><div v-for="day in form.working_hours" :key="day.weekday"><label class="check-field"><input v-model="day.is_working" type="checkbox" :true-value="1" :false-value="0" /> {{ day.weekday }}</label><input v-model="day.opens_at" type="time" :disabled="!day.is_working" /><span>—</span><input v-model="day.closes_at" type="time" :disabled="!day.is_working" /></div></div></div>
        <div class="form-section"><h3>Продажи</h3><div class="form-grid checks-grid">
          <label class="check-field"><input v-model="form.allow_free_price" type="checkbox" :true-value="1" :false-value="0" /> Свободная цена</label>
          <label class="check-field"><input v-model="form.allow_discounts" type="checkbox" :true-value="1" :false-value="0" /> Разрешить скидки</label>
          <label>Максимальная скидка, %<input v-model.number="form.max_discount_percent" type="number" min="0" max="100" /></label>
          <label class="check-field"><input v-model="form.allow_remove_cart_item" type="checkbox" :true-value="1" :false-value="0" /> Удаление из корзины</label>
        </div></div>
        <div class="form-section"><h3>Оплата</h3><div class="form-grid payment-grid">
          <label class="check-field"><input v-model="form.accepts_cash" type="checkbox" :true-value="1" :false-value="0" /> Наличные</label>
          <label class="check-field"><input v-model="form.accepts_card" type="checkbox" :true-value="1" :false-value="0" /> Карта</label>
          <label>Счёт для эквайринга<select v-model="form.card_bank_account" :disabled="!form.accepts_card"><option value="">Не выбран</option><option v-for="item in entityAccounts" :key="item.name" :value="item.name">{{ item.bank_name }} · {{ item.settlement_account }}</option></select></label>
          <label class="check-field"><input v-model="form.accepts_qr" type="checkbox" :true-value="1" :false-value="0" /> QR-код</label>
          <label>Счёт для QR<select v-model="form.qr_bank_account" :disabled="!form.accepts_qr"><option value="">Не выбран</option><option v-for="item in entityAccounts" :key="item.name" :value="item.name">{{ item.bank_name }} · {{ item.settlement_account }}</option></select></label>
        </div></div>
        <p v-if="formError" class="form-error">{{ formError }}</p>
      </form>

      <div v-else class="warehouse-editor">
        <div class="warehouse-summary"><div><span>Склад</span><b>{{ form.warehouse_name }}</b></div><div><span>Точка продаж</span><b>{{ form.business_point }}</b></div><div><span>Статус</span><b>{{ form.active ? 'Активен' : 'Выключен' }}</b></div></div>
        <section class="storage-section"><h3>Шкафы и места хранения</h3>
          <div v-if="detail.cabinets?.length" class="cabinet-grid"><article v-for="cabinet in detail.cabinets" :key="cabinet.name"><h4>{{ cabinet.cabinet_name }}</h4><div v-for="place in cabinet.locations" :key="place.name" class="location-row">{{ place.location_name }}</div><button type="button" class="text-button" @click="locationForm.cabinet = cabinet.name">＋ Добавить место</button></article></div>
          <p v-else class="muted-note">Шкафов пока нет.</p>
          <div class="inline-form"><input v-model="cabinetForm.cabinet_number" type="number" min="1" placeholder="Номер шкафа" /><button class="button button-secondary" type="button" @click="saveCabinet">Добавить шкаф</button></div>
          <div v-if="locationForm.cabinet" class="inline-form accent-inline"><input v-model="locationForm.location_name" placeholder="Название: Полка верхняя" /><button class="button button-secondary" type="button" @click="saveLocation">Сохранить место</button><button class="text-button" type="button" @click="locationForm.cabinet = ''">Отмена</button></div>
        </section>
        <section class="storage-section"><h3>Адреса товаров</h3>
          <div v-if="detail.item_storage?.length" class="compact-list"><div v-for="item in detail.item_storage" :key="item.name"><b>{{ item.item }}</b><span>{{ item.full_address }}</span></div></div>
          <div class="inline-form storage-inline"><select v-model="storageForm.item"><option value="">Выберите товар</option><option v-for="item in options.products" :key="item.name" :value="item.name">{{ item.item_name }}</option></select><select v-model="storageForm.storage_location"><option value="">Выберите место</option><option v-for="place in warehouseLocations" :key="place.name" :value="place.name">{{ place.full_address }}</option></select><button class="button button-secondary" type="button" @click="saveStorage">Назначить адрес</button></div>
        </section>
        <p v-if="formError" class="form-error">{{ formError }}</p>
      </div>

      <template v-if="reference !== 'warehouses'" #footer>
        <div v-if="form.name" class="danger-actions"><button class="text-button" type="button" @click="setActive(form.active ? 0 : 1)">{{ form.active ? 'Архивировать' : 'Восстановить' }}</button><span v-if="reference === 'entities'" class="muted-note">Запись сохраняется в истории и не удаляется.</span></div>
        <div class="footer-actions"><button class="button button-secondary" type="button" @click="detail = null">Отмена</button><button class="button button-primary" type="button" :disabled="saving" @click="saveReference">{{ saving ? 'Сохраняем…' : 'Сохранить' }}</button></div>
      </template>
    </AppModal>
  </section>
</template>
