<script setup>
import { onMounted, reactive, ref } from "vue";
import { call } from "../api";

const templates = ref([]);
const variables = ref([]);
const canEdit = ref(false);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const notice = ref("");
const preview = ref(false);
const form = reactive(empty());

function empty() {
  return { name: "", template_name: "", document_type: "Трудовой договор", active: 1, version: 1, template_html: "", notes: "" };
}
function reset(values = null) {
  Object.keys(form).forEach((key) => delete form[key]);
  Object.assign(form, values ? JSON.parse(JSON.stringify(values)) : empty());
}
async function load() {
  loading.value = true;
  try {
    const result = await call("raspechatka.api.hr_documents.get_hr_template_settings");
    templates.value = result.templates || [];
    variables.value = result.variables || [];
    canEdit.value = result.can_edit;
  } catch (exception) { error.value = exception.message; }
  finally { loading.value = false; }
}
function insertVariable(key) {
  form.template_html += `{{${key}}}`;
}
async function save() {
  saving.value = true; error.value = ""; notice.value = "";
  try {
    const result = await call("raspechatka.api.hr_documents.save_hr_template", { data: JSON.stringify(form) }, { method: "POST" });
    notice.value = `Шаблон сохранён. Версия ${result.version}.`;
    await load();
    const current = templates.value.find((item) => item.name === result.name);
    reset(current);
  } catch (exception) { error.value = exception.message; }
  finally { saving.value = false; }
}
async function seed() {
  try {
    const result = await call("raspechatka.api.hr_documents.create_default_hr_templates", {}, { method: "POST" });
    notice.value = result.created ? `Создано шаблонов: ${result.created}.` : "Шаблоны уже созданы.";
    await load();
  } catch (exception) { error.value = exception.message; }
}
onMounted(load);
</script>

<template>
  <section class="template-settings">
    <div class="heading">
      <div><h3>Шаблоны документов для трудоустройства</h3><p>Редактируйте текст прямо здесь. Переменные при формировании заменяются данными сотрудника, точки, должности и работодателя.</p></div>
      <button v-if="canEdit" class="button button-secondary" type="button" @click="seed">Создать стандартные шаблоны</button>
    </div>
    <p v-if="loading" class="muted-note">Загружаем шаблоны…</p>
    <template v-else>
      <div class="template-layout">
        <aside>
          <button v-if="canEdit" class="button button-primary" type="button" @click="reset()">＋ Новый шаблон</button>
          <button v-for="item in templates" :key="item.name" type="button" :class="{ selected: form.name === item.name }" @click="reset(item)">
            <b>{{ item.template_name }}</b><small>{{ item.document_type }} · версия {{ item.version }}{{ item.active ? "" : " · выключен" }}</small>
          </button>
        </aside>
        <form v-if="canEdit" class="template-editor" @submit.prevent="save">
          <div class="editor-grid">
            <label>Название<input v-model="form.template_name" required /></label>
            <label>Вид документа<select v-model="form.document_type"><option>Трудовой договор</option><option>Персональные данные</option><option>Должностные обязанности</option><option>Неразглашение</option></select></label>
            <label class="check-field"><input v-model="form.active" type="checkbox" :true-value="1" :false-value="0" /> Действует</label>
          </div>
          <div><b>Переменные</b><div class="variable-list"><button v-for="item in variables" :key="item.key" type="button" :title="item.label" @click="insertVariable(item.key)">{{ item.label }}</button></div></div>
          <div class="editor-switch"><b>Текст шаблона</b><button class="button button-secondary" type="button" @click="preview = !preview">{{ preview ? "Вернуться к редактору" : "Предпросмотр" }}</button></div>
          <div v-if="preview" class="document-preview" v-html="form.template_html"></div>
          <textarea v-else v-model="form.template_html" rows="18" required aria-label="Текст шаблона" placeholder="<h1>Трудовой договор</h1><p>{{FIO_FULL}}...</p>"></textarea>
          <p class="muted-note">Поддерживается HTML-разметка: заголовки, абзацы, списки, таблицы и выделение текста. Неизвестные переменные сохранить нельзя.</p>
          <label>Комментарий<textarea v-model="form.notes" rows="2"></textarea></label>
          <div class="actions"><button class="button button-primary" type="submit" :disabled="saving">{{ saving ? "Сохраняем…" : "Сохранить новую версию" }}</button></div>
        </form>
        <p v-else class="muted-note">Просмотр доступен. Изменять шаблоны может администратор сети.</p>
      </div>
    </template>
    <p v-if="notice" class="success">{{ notice }}</p><p v-if="error" class="form-error">{{ error }}</p>
  </section>
</template>

<style scoped>
.template-settings{display:grid;gap:20px;padding-top:26px;border-top:1px solid var(--border,#e1e5df)}.heading{display:flex;justify-content:space-between;gap:18px}.heading h3{margin:0 0 6px}.heading p{margin:0;color:#687165}.template-layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:20px}.template-layout aside{display:grid;align-content:start;gap:8px}.template-layout aside>button:not(.button){display:grid;text-align:left;gap:4px;padding:12px;border:1px solid #dde4d8;border-radius:9px;background:#fff}.template-layout aside>button.selected{border-color:#78a940;background:#f5faef}.template-layout small{color:#6d756a}.template-editor{display:grid;gap:15px}.editor-grid{display:grid;grid-template-columns:2fr 1fr auto;gap:12px}.template-editor label{display:grid;gap:6px}.template-editor textarea{width:100%;font-family:inherit}.editor-switch{display:flex;justify-content:space-between;align-items:center}.document-preview{min-height:320px;padding:28px 36px;border:1px solid #dfe3dc;border-radius:8px;background:#fff;box-shadow:0 2px 8px #1d251b12}.document-preview :deep(h1){text-align:center;font-size:22px}.document-preview :deep(p){line-height:1.5;text-align:justify}.variable-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.variable-list button{border:1px solid #d6dfd0;border-radius:999px;background:#f7faf4;padding:5px 9px;font-size:12px}.check-field{display:flex!important;align-items:center;gap:7px}.check-field input{width:auto}.actions{display:flex;justify-content:flex-end}.success{color:#38761d}@media(max-width:850px){.template-layout{grid-template-columns:1fr}.editor-grid{grid-template-columns:1fr}.heading{flex-direction:column}}
</style>
