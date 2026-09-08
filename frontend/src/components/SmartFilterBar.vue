<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { call } from "../api";
import { setDocumentFilterMatches, viewDoctypes } from "../listDocumentFilters";

const props = defineProps({
  fields: { type: Array, default: () => [] },
  modelValue: { type: Object, required: true },
  viewKey: { type: String, required: true },
  doctype: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue", "apply", "reset"]);
const settingsOpen = ref(false), visible = ref([]), bookmarks = ref([]), ready = ref(false), schemaFields = ref([]), schemaLoading = ref(false), schemaError = ref("");
const documentType = computed(() => props.doctype || viewDoctypes[props.viewKey] || "");
const preferenceKey = computed(() => `${props.viewKey}.filters`);
const fields = computed(() => {
  const schemaByKey = new Map(schemaFields.value.map((field) => [field.key, field]));
  const configured = props.fields.map((field) => {
    const schemaField = schemaByKey.get(field.key);
    return { ...schemaField, ...field, source: "configured", doctypeField: Boolean(schemaField) };
  });
  const keys = new Set(configured.map((field) => field.key));
  return [...configured, ...schemaFields.value.filter((field) => !keys.has(field.key)).map((field) => ({ ...field, source: "doctype", doctypeField: true, default: false }))];
});
const shownFields = computed(() => fields.value.filter((field) => visible.value.includes(field.key)));
const periodFieldPair = computed(() => {
  const dateFields = fields.value.filter((field) => field.type === "date");
  const byKey = new Map(dateFields.map((field) => [field.key, field]));
  const knownPairs = [["from_date", "to_date"], ["date_from", "date_to"], ["period_from", "period_to"], ["start_date", "end_date"]];
  for (const [fromKey, toKey] of knownPairs) {
    if (byKey.has(fromKey) && byKey.has(toKey)) return { from: byKey.get(fromKey), to: byKey.get(toKey) };
  }
  const from = dateFields.find((field) => /(^|\\s)(с|от)$/i.test((field.label || "").trim()));
  const to = dateFields.find((field) => /(^|\\s)(по|до)$/i.test((field.label || "").trim()));
  return from && to ? { from, to } : null;
});
const operatorOptions = {
  text: [{ value: "contains", label: "содержит" }, { value: "equals", label: "равно" }, { value: "not_equals", label: "не равно" }, { value: "not_contains", label: "не содержит" }, { value: "is_set", label: "заполнено" }, { value: "is_not_set", label: "не заполнено" }],
  exact: [{ value: "equals", label: "равно" }, { value: "not_equals", label: "не равно" }, { value: "is_set", label: "заполнено" }, { value: "is_not_set", label: "не заполнено" }],
  range: [{ value: "equals", label: "равно" }, { value: "greater_than", label: "больше" }, { value: "greater_or_equal", label: "не меньше" }, { value: "less_than", label: "меньше" }, { value: "less_or_equal", label: "не больше" }, { value: "is_set", label: "заполнено" }, { value: "is_not_set", label: "не заполнено" }],
};

function defaults() { return fields.value.filter((field) => field.default !== false).map((field) => field.key); }
function setValue(key, value) {
  const next = { ...props.modelValue, [key]: value };
  if (periodFieldPair.value && [periodFieldPair.value.from.key, periodFieldPair.value.to.key].includes(key)) next.__periodPreset = "";
  emit("update:modelValue", next);
}
function formatDateValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function periodValues(preset) {
  if (!periodFieldPair.value || !preset) return {};
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = new Date(today);
  const to = new Date(today);
  if (preset === "yesterday") {
    from.setDate(from.getDate() - 1);
    to.setDate(to.getDate() - 1);
  } else if (preset === "week") {
    from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
  } else if (preset === "month") {
    from.setDate(1);
  }
  return {
    [periodFieldPair.value.from.key]: formatDateValue(from),
    [periodFieldPair.value.to.key]: formatDateValue(to),
    __periodPreset: preset,
  };
}
function resolvePeriodPreset(filters) {
  return filters?.__periodPreset ? { ...filters, ...periodValues(filters.__periodPreset) } : filters;
}
function setPeriod(preset) {
  emit("update:modelValue", { ...props.modelValue, ...periodValues(preset) });
}
function operatorKey(field) { return `${field.key}__operator`; }
function defaultOperator(field) { return field.type === "select" ? "equals" : (["number", "date", "datetime-local", "time"].includes(field.type) ? "equals" : "contains"); }
function selectedOperator(field) { return props.modelValue[operatorKey(field)] || defaultOperator(field); }
function operators(field) { return field.type === "select" ? operatorOptions.exact : (["number", "date", "datetime-local", "time"].includes(field.type) ? operatorOptions.range : operatorOptions.text); }
function needsValue(field) { return !["is_set", "is_not_set"].includes(selectedOperator(field)); }
function dynamicCriteria() {
  return fields.value.filter((field) => field.doctypeField).flatMap((field) => {
    const operator = selectedOperator(field), value = props.modelValue[field.key];
    if (needsValue(field) && (value === undefined || value === null || value === "")) return [];
    return [{ fieldname: field.key, operator, value }];
  });
}
async function savePreference(extra = {}) {
  if (!ready.value) return;
  await call("raspechatka.api.references.save_view_preference", { view_key: preferenceKey.value, settings: JSON.stringify({ visible: visible.value, bookmarks: bookmarks.value, lastFilters: props.modelValue, ...extra }) }, { method: "POST" });
}
async function loadSchema() {
  schemaFields.value = []; schemaError.value = "";
  if (!documentType.value) return;
  schemaLoading.value = true;
  try { schemaFields.value = await call("raspechatka.api.list_filters.get_doctype_filter_fields", { doctype: documentType.value }); }
  catch (exception) { schemaError.value = exception.message; }
  finally { schemaLoading.value = false; }
}
async function loadPreference() {
  ready.value = false; let restored = false;
  await loadSchema();
  visible.value = defaults(); bookmarks.value = []; setDocumentFilterMatches(props.viewKey, null);
  try {
    const preference = await call("raspechatka.api.references.get_view_preference", { view_key: preferenceKey.value });
    const valid = (preference.visible || []).filter((key) => fields.value.some((field) => field.key === key));
    if (valid.length) visible.value = valid;
    bookmarks.value = Array.isArray(preference.bookmarks) ? preference.bookmarks : [];
    if (preference.lastFilters) { emit("update:modelValue", { ...props.modelValue, ...resolvePeriodPreset(preference.lastFilters) }); restored = true; }
  } catch (_) {
    // The complete default field set remains available without saved preferences.
  } finally { ready.value = true; if (restored) { await nextTick(); await apply(); } }
}
async function toggleField(key) {
  if (visible.value.includes(key)) { if (visible.value.length === 1) return; visible.value = visible.value.filter((item) => item !== key); }
  else visible.value = [...visible.value, key];
  await savePreference();
}
async function apply() {
  schemaError.value = "";
  if (documentType.value) {
    try {
      const names = await call("raspechatka.api.list_filters.filter_document_names", { doctype: documentType.value, filters: JSON.stringify(dynamicCriteria()) });
      setDocumentFilterMatches(props.viewKey, names);
    } catch (exception) { schemaError.value = exception.message; return; }
  }
  await savePreference(); emit("apply");
}
async function reset() {
  const empty = { ...Object.fromEntries(fields.value.flatMap((field) => [[field.key, field.emptyValue ?? ""], [operatorKey(field), defaultOperator(field)]])), __periodPreset: "" };
  emit("update:modelValue", empty); setDocumentFilterMatches(props.viewKey, null);
  await savePreference({ lastFilters: empty }); emit("reset");
}
async function createBookmark() {
  const name = window.prompt("Название закладки");
  if (!name?.trim()) return;
  bookmarks.value = [...bookmarks.value, { id: `${Date.now()}`, name: name.trim(), filters: { ...props.modelValue }, visible: [...visible.value] }];
  await savePreference();
}
async function useBookmark(bookmark) {
  visible.value = bookmark.visible?.filter((key) => fields.value.some((field) => field.key === key)) || defaults();
  const filters = resolvePeriodPreset(bookmark.filters);
  emit("update:modelValue", { ...props.modelValue, ...filters });
  await savePreference({ lastFilters: filters }); await nextTick(); await apply();
}
async function removeBookmark(id) { bookmarks.value = bookmarks.value.filter((item) => item.id !== id); await savePreference(); }

watch(() => [props.viewKey, documentType.value], loadPreference);
onMounted(loadPreference);
</script>

<template>
  <section class="smart-filter">
    <div class="smart-filter-topline">
      <strong>Фильтр</strong>
      <div class="smart-filter-actions">
        <span v-if="schemaLoading" class="filter-schema-state">Поля загружаются…</span>
        <button class="icon-action" type="button" title="Настроить поля" aria-label="Настроить поля фильтра" @click="settingsOpen=!settingsOpen">⚙</button>
        <button class="icon-action" type="button" title="Сохранить закладку" aria-label="Сохранить фильтр как закладку" @click="createBookmark">☆</button>
      </div>
      <div v-if="settingsOpen" class="filter-field-popover">
        <label v-for="field in fields" :key="field.key"><input type="checkbox" :checked="visible.includes(field.key)" @change="toggleField(field.key)" /><span>{{ field.label }}<small v-if="field.child_table">табличная часть</small></span></label>
      </div>
    </div>
    <div class="smart-filter-grid">
      <label v-for="field in shownFields" :key="field.key" class="smart-filter-field" :class="{ wide: field.wide, dynamic: field.source==='doctype' }">
        <span>{{ field.label }}</span>
        <div class="filter-value">
          <select v-if="field.doctypeField" class="filter-operator" :value="selectedOperator(field)" @change="setValue(operatorKey(field),$event.target.value)">
            <option v-for="operator in operators(field)" :key="operator.value" :value="operator.value">{{ operator.label }}</option>
          </select>
          <select v-if="field.type==='select'&&needsValue(field)" :value="modelValue[field.key]" @change="setValue(field.key,$event.target.value)">
            <option :value="field.emptyValue??''">{{ field.allLabel || 'Все' }}</option>
            <option v-for="option in field.options||[]" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <input v-else-if="needsValue(field)" :type="field.type||'text'" :value="modelValue[field.key]" :placeholder="field.placeholder||''" @input="setValue(field.key,$event.target.value)" @keyup.enter="apply" />
          <span v-else class="filter-no-value">Значение не требуется</span>
        </div>
        <div v-if="periodFieldPair && field.key === periodFieldPair.from.key" class="filter-period-presets" aria-label="Быстрый выбор периода">
          <button type="button" :class="{ active: modelValue.__periodPreset === 'today' }" @click.prevent.stop="setPeriod('today')">Сегодня</button>
          <button type="button" :class="{ active: modelValue.__periodPreset === 'yesterday' }" @click.prevent.stop="setPeriod('yesterday')">Вчера</button>
          <button type="button" :class="{ active: modelValue.__periodPreset === 'week' }" @click.prevent.stop="setPeriod('week')">Неделя</button>
          <button type="button" :class="{ active: modelValue.__periodPreset === 'month' }" @click.prevent.stop="setPeriod('month')">Месяц</button>
        </div>
      </label>
      <div class="smart-filter-submit"><button class="button button-primary" type="button" @click="apply">Найти</button><button class="button button-secondary" type="button" @click="reset">Очистить</button></div>
    </div>
    <p v-if="schemaError" class="filter-schema-error">{{ schemaError }}</p>
    <div v-if="bookmarks.length" class="filter-bookmarks"><span>Закладки</span><button v-for="bookmark in bookmarks" :key="bookmark.id" type="button" @click="useBookmark(bookmark)">{{ bookmark.name }}<i title="Удалить" @click.stop="removeBookmark(bookmark.id)">×</i></button></div>
  </section>
</template>
