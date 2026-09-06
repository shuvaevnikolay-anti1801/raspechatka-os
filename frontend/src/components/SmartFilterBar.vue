<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { call } from "../api";

const props = defineProps({
  fields: { type: Array, default: () => [] },
  modelValue: { type: Object, required: true },
  viewKey: { type: String, required: true },
});
const emit = defineEmits(["update:modelValue", "apply", "reset"]);

const settingsOpen = ref(false);
const visible = ref([]);
const bookmarks = ref([]);
const ready = ref(false);
const preferenceKey = computed(() => `${props.viewKey}.filters`);
const shownFields = computed(() => props.fields.filter((field) => visible.value.includes(field.key)));

function defaults() {
  return props.fields.filter((field) => field.default !== false).map((field) => field.key);
}
function setValue(key, value) {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}
async function savePreference(extra = {}) {
  if (!ready.value) return;
  await call("raspechatka.api.references.save_view_preference", {
    view_key: preferenceKey.value,
    settings: JSON.stringify({ visible: visible.value, bookmarks: bookmarks.value, lastFilters: props.modelValue, ...extra }),
  }, { method: "POST" });
}
async function loadPreference() {
  ready.value = false;
  let restored = false;
  visible.value = defaults(); bookmarks.value = [];
  try {
    const preference = await call("raspechatka.api.references.get_view_preference", { view_key: preferenceKey.value });
    const valid = (preference.visible || []).filter((key) => props.fields.some((field) => field.key === key));
    if (valid.length) visible.value = valid;
    bookmarks.value = Array.isArray(preference.bookmarks) ? preference.bookmarks : [];
    if (preference.lastFilters) { emit("update:modelValue", { ...props.modelValue, ...preference.lastFilters }); restored = true; }
  } catch (_) {
    // Defaults keep the list fully usable when preferences are unavailable.
  } finally { ready.value = true; if (restored) emit("apply"); }
}
async function toggleField(key) {
  if (visible.value.includes(key)) {
    if (visible.value.length === 1) return;
    visible.value = visible.value.filter((item) => item !== key);
  } else visible.value = [...visible.value, key];
  await savePreference();
}
async function apply() { await savePreference(); emit("apply"); }
async function reset() {
  const empty = Object.fromEntries(props.fields.map((field) => [field.key, field.emptyValue ?? ""]));
  emit("update:modelValue", empty); await savePreference({ lastFilters: empty }); emit("reset");
}
async function createBookmark() {
  const name = window.prompt("Название закладки");
  if (!name?.trim()) return;
  const bookmark = { id: `${Date.now()}`, name: name.trim(), filters: { ...props.modelValue }, visible: [...visible.value] };
  bookmarks.value = [...bookmarks.value, bookmark]; await savePreference();
}
async function useBookmark(bookmark) {
  visible.value = bookmark.visible?.filter((key) => props.fields.some((field) => field.key === key)) || defaults();
  emit("update:modelValue", { ...props.modelValue, ...bookmark.filters });
  await savePreference({ lastFilters: bookmark.filters }); emit("apply");
}
async function removeBookmark(id) { bookmarks.value = bookmarks.value.filter((item) => item.id !== id); await savePreference(); }

watch(() => props.viewKey, loadPreference);
onMounted(loadPreference);
</script>

<template>
  <section class="smart-filter">
    <div class="smart-filter-topline">
      <strong>Фильтр</strong>
      <div class="smart-filter-actions">
        <button class="icon-action" type="button" title="Настроить поля" aria-label="Настроить поля фильтра" @click="settingsOpen=!settingsOpen">⚙</button>
        <button class="icon-action" type="button" title="Сохранить закладку" aria-label="Сохранить фильтр как закладку" @click="createBookmark">☆</button>
      </div>
      <div v-if="settingsOpen" class="filter-field-popover">
        <label v-for="field in fields" :key="field.key"><input type="checkbox" :checked="visible.includes(field.key)" @change="toggleField(field.key)" />{{ field.label }}</label>
      </div>
    </div>
    <div class="smart-filter-grid">
      <label v-for="field in shownFields" :key="field.key" class="smart-filter-field" :class="{ wide: field.wide }">
        <span>{{ field.label }}</span>
        <select v-if="field.type==='select'" :value="modelValue[field.key]" @change="setValue(field.key,$event.target.value)">
          <option :value="field.emptyValue??''">{{ field.allLabel || 'Все' }}</option>
          <option v-for="option in field.options||[]" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <input v-else :type="field.type||'text'" :value="modelValue[field.key]" :placeholder="field.placeholder||''" @input="setValue(field.key,$event.target.value)" @keyup.enter="apply" />
      </label>
      <div class="smart-filter-submit"><button class="button button-primary" type="button" @click="apply">Найти</button><button class="button button-secondary" type="button" @click="reset">Очистить</button></div>
    </div>
    <div v-if="bookmarks.length" class="filter-bookmarks">
      <span>Закладки</span>
      <button v-for="bookmark in bookmarks" :key="bookmark.id" type="button" @click="useBookmark(bookmark)">{{ bookmark.name }}<i title="Удалить" @click.stop="removeBookmark(bookmark.id)">×</i></button>
    </div>
  </section>
</template>
