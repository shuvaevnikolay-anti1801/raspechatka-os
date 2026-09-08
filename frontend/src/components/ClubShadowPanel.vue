<script setup>
import { onMounted, reactive, ref } from "vue";
import { call } from "../api";

const state = ref(null);
const error = ref("");
const busy = ref(false);
const form = reactive({
  enabled: false,
  business_point: "",
  source_id: "",
  shared_secret: "",
});
async function load() {
  try {
    state.value = await call("raspechatka.api.club_shadow.status");
    Object.assign(form, {
      enabled: state.value.enabled,
      business_point: state.value.business_point || "",
      source_id: state.value.source_id || "",
    });
  } catch (e) {
    error.value = e.message;
  }
}
async function save() {
  busy.value = true;
  error.value = "";
  try {
    await call(
      "raspechatka.api.club_shadow.configure",
      { data: JSON.stringify(form) },
      { method: "POST" }
    );
    form.shared_secret = "";
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>

<template>
  <section class="settings-panel shadow-panel">
    <h2>Параллельный перенос из Google</h2>
    <p>
      Google пока остаётся основной системой. Этот обмен не изменяет Tilda,
      BotHelp и МойСклад. Импортированные карточки защищены от ручных изменений.
    </p>
    <p v-if="error" role="alert" class="form-error">{{ error }}</p>
    <template v-if="state">
      <form class="form-grid" @submit.prevent="save">
        <label
          >Точка старых клиентов
          <select v-model="form.business_point" required>
            <option value="">
              Ярославль, Комсомольская, 12 — выберите запись
            </option>
            <option v-for="p in state.points" :key="p.name" :value="p.name">
              {{ p.point_name }} — {{ p.city }}, {{ p.address }}
            </option>
          </select>
        </label>
        <label
          >ID таблицы «Клуб Распечатка»<input
            v-model="form.source_id"
            required
            autocomplete="off"
        /></label>
        <label
          >Ключ подписи (не менее 32 символов)
          <input
            v-model="form.shared_secret"
            type="password"
            autocomplete="new-password"
            :placeholder="
              state.secret_configured
                ? 'Сохранён. Оставьте пустым, чтобы не менять'
                : 'Тот же ключ задайте в Script Properties'
            "
          />
        </label>
        <label
          ><input v-model="form.enabled" type="checkbox" /> Принимать данные из
          Google</label
        >
        <button class="button button-primary" :disabled="busy">
          {{ busy ? "Сохраняем…" : "Сохранить обмен" }}
        </button>
      </form>
      <p>
        Перенесено клиентов: {{ state.clients }}. Последний приём:
        {{ state.last_received_at || "ещё не было" }}.
      </p>
      <button class="button button-secondary" @click="load">
        Обновить состояние
      </button>
      <ul>
        <li v-for="receipt in state.recent" :key="receipt.name">
          {{ receipt.received_at }} —
          {{
            receipt.outcome === "MATCH"
              ? "Скидка и число каналов совпадают"
              : "Есть расхождение — проверьте правила клуба"
          }}
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.shadow-panel {
  margin-top: 24px;
}
.shadow-panel p {
  line-height: 1.5;
}
.shadow-panel ul {
  max-height: 200px;
  overflow: auto;
}
</style>
