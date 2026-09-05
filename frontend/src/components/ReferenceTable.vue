<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { call } from "../api";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  columns: { type: Array, required: true },
  viewKey: { type: String, required: true },
  loading: Boolean,
  error: String,
});
defineEmits(["open", "retry"]);

const selected = ref([]);
const settingsOpen = ref(false);
const visibleColumns = computed(() => props.columns.filter((column) => selected.value.includes(column.key)));

function display(row, column) {
  const value = row[column.key];
  if (column.format) return column.format(value, row);
  return value === undefined || value === null || value === "" ? "—" : value;
}

async function loadPreference() {
  const defaults = props.columns.filter((column) => column.default !== false).map((column) => column.key);
  selected.value = defaults;
  try {
    const preference = await call("raspechatka.api.references.get_view_preference", { view_key: props.viewKey });
    const valid = (preference.columns || []).filter((key) => props.columns.some((column) => column.key === key));
    if (valid.length) selected.value = valid;
  } catch (_) {
    // The table remains usable with default columns.
  }
}

async function toggleColumn(key) {
  if (selected.value.includes(key)) {
    if (selected.value.length === 1) return;
    selected.value = selected.value.filter((item) => item !== key);
  } else {
    selected.value = [...selected.value, key];
  }
  await call("raspechatka.api.references.save_view_preference", {
    view_key: props.viewKey,
    settings: JSON.stringify({ columns: selected.value }),
  }, { method: "POST" });
}

watch(() => props.viewKey, loadPreference);
onMounted(loadPreference);
</script>

<template>
  <div class="reference-table-wrap">
    <div class="table-meta">
      <strong>{{ rows.length }} записей</strong>
      <div class="column-settings">
        <button class="text-button" type="button" @click="settingsOpen = !settingsOpen">Настроить столбцы</button>
        <div v-if="settingsOpen" class="column-popover">
          <label v-for="column in columns" :key="column.key">
            <input type="checkbox" :checked="selected.includes(column.key)" @change="toggleColumn(column.key)" />
            <span>{{ column.label }}</span>
          </label>
        </div>
      </div>
    </div>
    <div class="table-shell">
      <div v-if="error" class="table-message error-message">
        <strong>Не удалось загрузить данные</strong><span>{{ error }}</span><button @click="$emit('retry')">Повторить</button>
      </div>
      <div v-else-if="loading" class="table-message"><span class="loader"></span><span>Загружаем справочник…</span></div>
      <div v-else-if="!rows.length" class="table-message"><strong>Список пока пуст</strong><span>Создайте первую запись.</span></div>
      <table v-else>
        <thead><tr><th v-for="column in visibleColumns" :key="column.key">{{ column.label }}</th><th></th></tr></thead>
        <tbody>
          <tr v-for="row in rows" :key="row.name" tabindex="0" @click="$emit('open', row)" @keydown.enter="$emit('open', row)">
            <td v-for="column in visibleColumns" :key="column.key" :class="{ 'item-name': column.primary }">
              <span v-if="column.key === 'active'" class="state" :class="{ inactive: !row.active }"><i></i>{{ row.active ? 'Активен' : 'Выключен' }}</span>
              <template v-else>{{ display(row, column) }}</template>
            </td>
            <td class="row-arrow">→</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
