<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { call } from "../api";
import ListPageHeader from "../components/ListPageHeader.vue";
import PayrollSettingsPanel from "../components/PayrollSettingsPanel.vue";
import HrDocumentTemplatesPanel from "../components/HrDocumentTemplatesPanel.vue";

const route = useRoute();
const router = useRouter();
const points = ref([]);
const point = ref("");
const loading = ref(true);
const error = ref("");
const selectedPoint = computed(() => points.value.find((item) => item.name === point.value));

async function loadPoints() {
  loading.value = true;
  try {
    points.value = await call("raspechatka.api.team.get_payroll_settings_options");
    const requested = String(route.query.point || "");
    point.value = points.value.some((item) => item.name === requested)
      ? requested
      : (points.value[0]?.name || "");
  } catch (exception) {
    error.value = exception.message;
  } finally {
    loading.value = false;
  }
}

watch(point, (value) => {
  if (value && route.query.point !== value) router.replace({ query: { ...route.query, point: value } });
});
onMounted(loadPoints);
</script>

<template>
  <section class="page team-settings-page">
    <ListPageHeader title="Настройки сотрудников" />
    <div class="settings-card">
      <div class="point-picker">
        <label>Точка продаж
          <select v-model="point" :disabled="loading">
            <option v-for="item in points" :key="item.name" :value="item.name">{{ item.point_name }}</option>
          </select>
        </label>
        <span v-if="selectedPoint">Юридическое лицо: {{ selectedPoint.business_entity }}</span>
      </div>
      <PayrollSettingsPanel v-if="point" :business-point="point" />
      <p v-else-if="!loading" class="muted-note">Нет доступных точек продаж.</p>
      <HrDocumentTemplatesPanel />
      <p v-if="error" class="form-error">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped>
.settings-card { display: grid; gap: 28px; padding: 24px; background: #fff; border: 1px solid var(--border, #dfe3e6); border-radius: 12px; }
.point-picker { display: flex; align-items: end; gap: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--border, #e7e9eb); }
.point-picker label { display: grid; gap: 7px; min-width: min(420px, 100%); }
.point-picker span { color: var(--text-muted, #667085); padding-bottom: 10px; }
@media (max-width: 620px) { .settings-card { padding: 16px; } .point-picker { align-items: stretch; flex-direction: column; } }
</style>
