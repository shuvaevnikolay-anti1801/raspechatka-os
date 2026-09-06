<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { call } from "../api";

const route = useRoute();
const loading = ref(true);
const error = ref("");
const point = ref("");
const month = ref(new Date().toISOString().slice(0, 7));
const data = ref({ counters: {}, employees: [], points: [], schedules: [], motivation_periods: [], payroll_components: [] });
const schedule = ref({ entries: [], days: 0 });
const recalculating = ref(false);

const section = computed(() => route.meta.section || "employees");
const title = computed(() => ({ employees: "Сотрудники", schedule: "График работы", payroll: "Зарплата", bonuses: "Премии и игра", hr: "Кадры и документы" })[section.value]);
const pointNames = computed(() => Object.fromEntries(data.value.points.map((item) => [item.name, item.point_name])));

async function load() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await call("raspechatka.api.team.get_team_overview", {
      business_point: point.value,
      month: `${month.value}-01`,
    });
    if (section.value === "schedule" && point.value) {
      schedule.value = await call("raspechatka.api.team.get_schedule", {
        business_point: point.value,
        month: `${month.value}-01`,
      });
    } else {
      schedule.value = { entries: [], days: 0 };
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function recalculate(period) {
  recalculating.value = true;
  error.value = "";
  try {
    await call("raspechatka.api.team.recalculate_motivation", { period }, { method: "POST" });
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    recalculating.value = false;
  }
}

watch([point, month, section], load);
onMounted(load);
</script>

<template>
  <section class="page team-page">
    <div class="page-heading team-heading">
      <div><div class="eyebrow">ЛЮДИ И РАБОТА</div><h1>{{ title }}</h1><p>Единый контур сотрудников для всех организаций и точек сети.</p></div>
      <div class="team-filters">
        <select v-model="point"><option value="">Все доступные точки</option><option v-for="item in data.points" :key="item.name" :value="item.name">{{ item.point_name }} · {{ item.city }}</option></select>
        <input v-model="month" type="month" />
      </div>
    </div>

    <div v-if="error" class="team-error">{{ error }} <button @click="load">Повторить</button></div>
    <div v-else-if="loading" class="team-loading">Загружаем данные сотрудников…</div>
    <template v-else>
      <div class="team-stats">
        <article><span>Активные сотрудники</span><b>{{ data.counters.active_employees || 0 }}</b></article>
        <article><span>Точки в доступе</span><b>{{ data.counters.points || 0 }}</b></article>
        <article><span>Опубликовано графиков</span><b>{{ data.counters.published_schedules || 0 }}</b></article>
        <article><span>Активные игры</span><b>{{ data.counters.active_games || 0 }}</b></article>
      </div>

      <div v-if="section === 'employees'" class="team-panel">
        <div class="panel-title"><div><h2>Команда сети</h2><p>Карточка сотрудника, работодатель, должность и назначенные точки.</p></div><router-link class="button button-primary" to="/references/employees">Открыть карточки</router-link></div>
        <div v-if="!data.employees.length" class="team-empty"><b>Сотрудников пока нет</b><span>Создайте первую карточку в справочнике сотрудников.</span></div>
        <div v-else class="employee-list">
          <article v-for="employee in data.employees" :key="employee.name">
            <div class="employee-avatar">{{ (employee.first_name || employee.employee_name || 'С').slice(0, 1) }}</div>
            <div><h3>{{ employee.employee_name }}</h3><p>{{ employee.position || 'Должность не указана' }}</p></div>
            <div><span>Работодатель</span><b>{{ employee.business_entity }}</b></div>
            <div><span>Основная точка</span><b>{{ pointNames[employee.default_point] || 'Не назначена' }}</b></div>
            <span class="employee-status">Работает</span>
          </article>
        </div>
      </div>

      <div v-else-if="section === 'schedule'" class="team-panel">
        <div class="panel-title"><div><h2>План и факт смен</h2><p>Плановый график автоматически сопоставляется с фактическими кассовыми сменами.</p></div></div>
        <div v-if="!point" class="team-empty"><b>Выберите точку</b><span>График составляется отдельно для каждой точки и месяца.</span></div>
        <div v-else-if="!schedule.entries.length" class="team-empty"><b>На этот месяц графика пока нет</b><span>Структура уже готова; следующим шагом добавим визуальный редактор календаря.</span></div>
        <div v-else class="schedule-list"><div v-for="entry in schedule.entries" :key="`${entry.date}-${entry.shift_template}-${entry.employee}`"><b>{{ entry.date }}</b><span>{{ entry.shift_template }}</span><span>{{ entry.employee }}</span><em>план {{ entry.planned_hours }} ч</em><em>факт {{ entry.actual_hours || 0 }} ч</em><b>{{ Number(entry.net_sales || 0).toLocaleString('ru-RU') }} ₽</b></div></div>
      </div>

      <div v-else-if="section === 'payroll'" class="team-panel">
        <div class="panel-title"><div><h2>Настройки начислений</h2><p>Ставки, проценты, способы выплаты и налоговая база по ИП и точке.</p></div></div>
        <div v-if="!data.payroll_components.length" class="team-empty"><b>Виды начислений пока не настроены</b><span>Добавьте оклад, почасовую ставку, процент или ручное начисление.</span></div>
        <div v-else class="payroll-list"><article v-for="item in data.payroll_components" :key="item.name"><div><h3>{{ item.component_name }}</h3><p>{{ item.component_code }} · {{ item.business_entity }}</p></div><span>{{ item.calculation_basis }}</span><b>{{ item.default_rate || item.default_percent || 0 }}</b><em>{{ item.payment_method }}</em></article></div>
      </div>

      <div v-else-if="section === 'bonuses'" class="team-panel">
        <div class="panel-title"><div><h2>Мотивационные периоды</h2><p>Отзывы, клуб, подарки и средний чек рассчитываются из фактических данных продаж.</p></div></div>
        <div v-if="!data.motivation_periods.length" class="team-empty"><b>Активной игры пока нет</b><span>После переноса настроек из вкладки «Премия» здесь появится текущий период.</span></div>
        <div v-else class="game-list"><article v-for="game in data.motivation_periods" :key="game.name"><div><h3>{{ game.title }}</h3><p>{{ pointNames[game.business_point] }} · {{ game.start_date }} — {{ game.end_date }}</p></div><code>{{ game.rules_version }}</code><button class="button" :disabled="recalculating" @click="recalculate(game.name)">Пересчитать</button></article></div>
      </div>

      <div v-else class="team-panel">
        <div class="panel-title"><div><h2>{{ title }}</h2><p>Карточка сотрудника хранит кадровые реквизиты и комплект документов с ограниченным доступом.</p></div></div>
        <div class="team-empty"><b>Основа данных подготовлена</b><span>Расчётную логику подключим после подтверждения правил и исходных шаблонов.</span></div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.team-page{display:grid;gap:20px}.team-heading{align-items:end}.team-filters{display:flex;gap:10px;flex-wrap:wrap}.team-filters select,.team-filters input{min-height:42px;border:1px solid #d8dfcf;border-radius:10px;background:#fff;padding:0 12px;color:#24311d}.team-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.team-stats article,.team-panel{border:1px solid #e1e6dc;border-radius:16px;background:#fff;box-shadow:0 8px 26px rgba(38,59,25,.06)}.team-stats article{padding:18px}.team-stats span{display:block;color:#71806a;font-size:13px}.team-stats b{display:block;margin-top:8px;font-size:28px;color:#284d1e}.team-panel{padding:22px}.panel-title{display:flex;justify-content:space-between;gap:18px;align-items:center;margin-bottom:18px}.panel-title h2{margin:0 0 5px}.panel-title p{margin:0;color:#74806f}.employee-list{display:grid;gap:8px}.employee-list article{display:grid;grid-template-columns:42px minmax(170px,1.2fr) minmax(140px,1fr) minmax(140px,1fr) auto;gap:14px;align-items:center;padding:12px;border:1px solid #edf0e9;border-radius:12px}.employee-avatar{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:#e9f6d8;color:#3f711d;font-weight:800}.employee-list h3,.game-list h3,.payroll-list h3{margin:0;font-size:15px}.employee-list p,.game-list p,.payroll-list p{margin:4px 0 0;color:#7a8576;font-size:13px}.employee-list article>div>span{display:block;color:#889184;font-size:11px}.employee-list article>div>b{font-size:13px}.employee-status{padding:6px 9px;border-radius:999px;background:#edf8e8;color:#3d7b28;font-size:12px;font-weight:700}.team-empty{display:grid;place-items:center;min-height:220px;text-align:center;color:#7a8575}.team-empty b{color:#35452e;font-size:18px}.team-empty span{max-width:520px}.team-error,.team-loading{padding:18px;border-radius:12px;background:#fff}.schedule-list,.payroll-list{display:grid;gap:7px}.schedule-list>div{display:grid;grid-template-columns:100px 100px minmax(140px,1fr) auto auto auto;gap:12px;padding:10px 12px;border-bottom:1px solid #edf0e9}.payroll-list article{display:grid;grid-template-columns:minmax(200px,1fr) 150px 100px 130px;gap:16px;align-items:center;padding:13px;border-bottom:1px solid #edf0e9}.game-list{display:grid;gap:10px}.game-list article{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px;border:1px solid #edf0e9;border-radius:12px}.game-list code{color:#67805b}@media(max-width:900px){.team-stats{grid-template-columns:repeat(2,1fr)}.employee-list article{grid-template-columns:42px 1fr}.employee-list article>div:nth-child(n+3),.employee-status{grid-column:2}.team-heading{display:block}.team-filters{margin-top:12px}.schedule-list>div,.payroll-list article{grid-template-columns:1fr 1fr}}@media(max-width:560px){.team-stats{grid-template-columns:1fr}.team-filters>*{width:100%}}
</style>
