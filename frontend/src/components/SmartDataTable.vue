<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { call } from "../api";

const props = defineProps({
  rows: { type: Array, default: () => [] }, columns: { type: Array, required: true }, viewKey: { type: String, required: true },
  loading: Boolean, error: String, rowKey: { type: String, default: "name" }, emptyTitle: { type: String, default: "Данных пока нет" },
  emptyText: { type: String, default: "Измените фильтры или создайте первую запись." }, totals: { type: Object, default: () => ({}) },
});
const emit = defineEmits(["open", "retry"]);
const selected = ref([]), widths = ref({}), settingsOpen = ref(false), page = ref(1), pageSize = ref(25), ready = ref(false);
const pageSizes = [25, 50, 100];
const preferenceKey = computed(() => `${props.viewKey}.table`);
const visibleColumns = computed(() => props.columns.filter((column) => selected.value.includes(column.key)));
const pageCount = computed(() => Math.max(1, Math.ceil(props.rows.length / pageSize.value)));
const pageRows = computed(() => props.rows.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
const from = computed(() => props.rows.length ? (page.value - 1) * pageSize.value + 1 : 0);
const to = computed(() => Math.min(page.value * pageSize.value, props.rows.length));
let resizing = null;

function display(row, column) { const value = row[column.key]; return column.format ? column.format(value, row) : (value === undefined || value === null || value === "" ? "—" : value); }
async function savePreference() {
  if (!ready.value) return;
  await call("raspechatka.api.references.save_view_preference", { view_key: preferenceKey.value, settings: JSON.stringify({ columns: selected.value, widths: widths.value, pageSize: pageSize.value }) }, { method: "POST" });
}
async function loadPreference() {
  ready.value = false; selected.value = props.columns.filter((column) => column.default !== false).map((column) => column.key); widths.value = {}; pageSize.value = 25; page.value = 1;
  try {
    const preference = await call("raspechatka.api.references.get_view_preference", { view_key: preferenceKey.value });
    const valid = (preference.columns || []).filter((key) => props.columns.some((column) => column.key === key));
    if (valid.length) selected.value = valid;
    widths.value = preference.widths || {};
    if (pageSizes.includes(Number(preference.pageSize))) pageSize.value = Number(preference.pageSize);
  } catch (_) {} finally { ready.value = true; }
}
async function toggleColumn(key) {
  selected.value = selected.value.includes(key) ? (selected.value.length > 1 ? selected.value.filter((item) => item !== key) : selected.value) : [...selected.value, key]; await savePreference();
}
function beginResize(event, column) {
  event.preventDefault(); resizing = { key: column.key, x: event.clientX, width: widths.value[column.key] || event.currentTarget.parentElement.offsetWidth };
  window.addEventListener("pointermove", resize); window.addEventListener("pointerup", endResize, { once: true });
}
function resize(event) { if (resizing) widths.value = { ...widths.value, [resizing.key]: Math.max(80, resizing.width + event.clientX - resizing.x) }; }
async function endResize() { window.removeEventListener("pointermove", resize); resizing = null; await savePreference(); }
function setPageSize(event) { pageSize.value = Number(event.target.value); page.value = 1; savePreference(); }

watch(() => props.viewKey, loadPreference); watch(() => props.rows.length, () => { if (page.value > pageCount.value) page.value = pageCount.value; });
onMounted(loadPreference); onBeforeUnmount(() => window.removeEventListener("pointermove", resize));
</script>

<template>
  <div class="smart-table">
    <div class="table-meta"><strong>{{ rows.length }} записей</strong><div class="column-settings"><button class="text-button" type="button" @click="settingsOpen=!settingsOpen">Настроить столбцы</button><div v-if="settingsOpen" class="column-popover"><label v-for="column in columns" :key="column.key"><input type="checkbox" :checked="selected.includes(column.key)" @change="toggleColumn(column.key)" /><span>{{ column.label }}</span></label></div></div></div>
    <div class="table-shell">
      <div v-if="error" class="table-message error-message"><strong>Не удалось загрузить данные</strong><span>{{ error }}</span><button @click="$emit('retry')">Повторить</button></div>
      <div v-else-if="loading" class="table-message"><span class="loader"></span><span>Загружаем данные…</span></div>
      <div v-else-if="!rows.length" class="table-message"><strong>{{ emptyTitle }}</strong><span>{{ emptyText }}</span></div>
      <table v-else>
        <colgroup><col v-for="column in visibleColumns" :key="column.key" :style="{width:(widths[column.key]||column.width||'auto')+(typeof (widths[column.key]||column.width)==='number'?'px':'')}" /></colgroup>
        <thead><tr><th v-for="column in visibleColumns" :key="column.key"><span>{{ column.label }}</span><i class="column-resizer" @pointerdown="beginResize($event,column)"></i></th></tr></thead>
        <tbody><tr v-for="row in pageRows" :key="row[rowKey]" tabindex="0" @click="$emit('open',row)" @keydown.enter="$emit('open',row)"><td v-for="column in visibleColumns" :key="column.key" :class="[{ 'item-name': column.primary, 'number-cell': column.number }, column.className]"><slot :name="`cell-${column.key}`" :row="row" :value="row[column.key]" :column="column">{{ display(row,column) }}</slot></td></tr></tbody>
        <tfoot v-if="Object.keys(totals).length"><tr><td v-for="column in visibleColumns" :key="column.key" :class="{ 'number-cell': column.number }"><strong v-if="column.primary">Итого</strong><strong v-else-if="totals[column.key]!==undefined">{{ column.format ? column.format(totals[column.key], totals) : totals[column.key] }}</strong></td></tr></tfoot>
      </table>
    </div>
    <footer class="table-footer"><span>{{ from }}–{{ to }} из {{ rows.length }}</span><div class="table-pages"><button :disabled="page===1" @click="page--">←</button><span>{{ page }} / {{ pageCount }}</span><button :disabled="page===pageCount" @click="page++">→</button></div><label>Строк на странице<select :value="pageSize" @change="setPageSize"><option v-for="size in pageSizes" :key="size" :value="size">{{size}}</option></select></label></footer>
  </div>
</template>
