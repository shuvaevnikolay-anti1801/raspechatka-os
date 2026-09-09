<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { call } from "../api";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartDataTable from "../components/SmartDataTable.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";

const route = useRoute();
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const point = ref("");
const month = ref(new Date().toISOString().slice(0, 7));
const data = ref({ counters: {}, employees: [], points: [], schedules: [], motivation_periods: [], payroll_components: [], shift_templates: [] });
const schedule = ref({ entries: [], days: 0, status: "" });
const draft = ref({});
const payroll = ref(null);
const payrollStart = ref("");
const payrollEnd = ref("");
const hr = ref({ employees: [], leaves: [], employee_names: {} });
const recalculating = ref(false);

const section = computed(() => route.meta.section || "employees");
const title = computed(() => ({ employees: "Сотрудники", schedule: "График работы", payroll: "Зарплата", bonuses: "Премии и игра", hr: "Кадры и документы" })[section.value]);
const pointNames = computed(() => Object.fromEntries(data.value.points.map((item) => [item.name, item.point_name])));
const days = computed(() => Array.from({ length: schedule.value.days || new Date(Number(month.value.slice(0,4)), Number(month.value.slice(5,7)), 0).getDate() }, (_, i) => i + 1));
const selectedPointEmployees = computed(() => point.value ? data.value.employees.filter((e) => (e.points || []).includes(point.value)) : data.value.employees);
const baseShifts = computed(() => data.value.shift_templates.slice(0, 2));
const morningShift = computed(() => baseShifts.value[0]);
const eveningShift = computed(() => baseShifts.value[1]);
const BOTH = "__BOTH__";
const dayCoverage = computed(() => Object.fromEntries(days.value.map((day) => {
  let morning = 0; let evening = 0;
  for (const employee of selectedPointEmployees.value) {
    const value = draft.value[cellKey(employee.name, day)];
    if (value === BOTH || value === morningShift.value?.name) morning += 1;
    if (value === BOTH || value === eveningShift.value?.name) evening += 1;
  }
  return [day, { morning, evening, ok: morning === 1 && evening === 1 }];
})));
const completeDays = computed(() => Object.values(dayCoverage.value).filter((item) => item.ok).length);
const plannedHours = computed(() => Object.fromEntries(selectedPointEmployees.value.map((employee) => [
  employee.name,
  days.value.reduce((sum, day) => {
    const value = draft.value[cellKey(employee.name, day)];
    if (value === BOTH) return sum + baseShifts.value.reduce((total, shift) => total + Number(shift?.paid_hours || 0), 0);
    return sum + Number(data.value.shift_templates.find((shift) => shift.name === value)?.paid_hours || 0);
  }, 0),
])));
const filterModel = computed({ get: () => ({ business_point: point.value, month: month.value }), set: (value) => { point.value = value.business_point; month.value = value.month; } });
const filterFields = computed(() => [
  { key: "business_point", label: "Точка", type: "select", allLabel: "Все доступные точки", options: data.value.points.map((item) => ({ value: item.name, label: `${item.point_name} · ${item.city || ""}` })) },
  { key: "month", label: "Месяц", type: "month" },
]);
const employeeColumns = computed(() => [
  { key: "employee_name", label: "Сотрудник", primary: true, width: 260 },
  { key: "position", label: "Должность", width: 180 },
  { key: "business_entity", label: "Работодатель", width: 200 },
  { key: "default_point", label: "Основная точка", width: 220, format: (value) => pointNames.value[value] || "Не назначена" },
  { key: "hire_date", label: "Принят", width: 120 },
]);
const payrollColumns = [
  { key: "employee_name", label: "Сотрудник", primary: true, width: 230 },
  { key: "hours", label: "Часы", width: 80 },
  { key: "hourly_amount", label: "Оклад", width: 120, format: money },
  { key: "personal_sales", label: "Личная выручка", width: 145, format: money },
  { key: "piecework_amount", label: "Сдельно", width: 115, format: money },
  { key: "bonus", label: "Премия", width: 110, format: money },
  { key: "gross_amount", label: "Начислено", width: 130, format: money },
  { key: "ndfl", label: "НДФЛ", width: 110, format: money },
  { key: "net_amount", label: "К выплате", width: 130, format: money },
  { key: "total_cost", label: "Стоимость", width: 130, format: money },
];
const leaveColumns = computed(() => [
  { key: "employee", label: "Сотрудник", primary: true, width: 230, format: (v) => hr.value.employee_names[v] || v },
  { key: "leave_type", label: "Вид", width: 210 },
  { key: "date_from", label: "С", width: 110 },
  { key: "date_to", label: "По", width: 110 },
  { key: "days", label: "Дней", width: 80 },
  { key: "status", label: "Статус", width: 120 },
  { key: "amount", label: "Сумма", width: 120, format: money },
]);

function money(value) { return `${Number(value || 0).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`; }
function isoDate(day) { return `${month.value}-${String(day).padStart(2, "0")}`; }
function cellKey(employee, day) { return `${employee}|${isoDate(day)}`; }
function shiftCode(name) { return data.value.shift_templates.find((x) => x.name === name)?.shift_code || "—"; }
function setPayrollDates() {
  const now = new Date();
  const [year, mon] = month.value.split("-").map(Number);
  const current = now.getFullYear() === year && now.getMonth() + 1 === mon ? now.getDate() : 16;
  payrollStart.value = `${month.value}-${current <= 15 ? "01" : "16"}`;
  payrollEnd.value = `${month.value}-${current <= 15 ? "15" : String(new Date(year, mon, 0).getDate()).padStart(2, "0")}`;
}
function hydrateDraft() {
  const next = {};
  for (const row of schedule.value.entries || []) {
    const key = `${row.employee}|${row.date}`;
    const current = next[key];
    next[key] = current && current !== row.shift_template ? BOTH : row.shift_template;
  }
  draft.value = next;
}

async function load() {
  loading.value = true; error.value = "";
  try {
    data.value = await call("raspechatka.api.team.get_team_overview", { business_point: point.value, month: `${month.value}-01` });
    if (!point.value && data.value.points.length === 1) { point.value = data.value.points[0].name; return; }
    if (section.value === "schedule" && point.value) {
      schedule.value = await call("raspechatka.api.team.get_schedule", { business_point: point.value, month: `${month.value}-01` });
      hydrateDraft();
    }
    if (section.value === "payroll") { if (!payrollStart.value) setPayrollDates(); payroll.value = null; }
    if (section.value === "hr") hr.value = await call("raspechatka.api.team.get_hr_overview", { business_point: point.value });
  } catch (e) { error.value = e.message; } finally { loading.value = false; }
}
async function saveSchedule(publish = false) {
  if (!point.value) return;
  saving.value = true; error.value = "";
  const entries = [];
  for (const [key, value] of Object.entries(draft.value)) {
    if (!value) continue;
    const [employee, date] = key.split("|");
    const shifts = value === BOTH ? baseShifts.value : data.value.shift_templates.filter((shift) => shift.name === value);
    for (const shift of shifts) entries.push({ employee, date, shift_template: shift.name });
  }
  try {
    await call("raspechatka.api.team.save_schedule", { business_point: point.value, month: `${month.value}-01`, entries: JSON.stringify(entries), publish: publish ? 1 : 0 }, { method: "POST" });
    await load();
  } catch (e) { error.value = e.message; } finally { saving.value = false; }
}
async function calculatePayroll(save = false) {
  if (!point.value) { error.value = "Выберите точку"; return; }
  saving.value = true; error.value = "";
  try { payroll.value = await call("raspechatka.api.team.calculate_payroll", { business_point: point.value, period_start: payrollStart.value, period_end: payrollEnd.value, save: save ? 1 : 0 }, { method: "POST" }); }
  catch (e) { error.value = e.message; } finally { saving.value = false; }
}
async function recalculate(period) {
  recalculating.value = true;
  try { await call("raspechatka.api.team.recalculate_motivation", { period }, { method: "POST" }); await load(); }
  catch (e) { error.value = e.message; } finally { recalculating.value = false; }
}
watch([point, month, section], load);
onMounted(load);
</script>

<template>
  <section class="page team-page">
    <ListPageHeader :title="title">
      <template #actions>
        <router-link v-if="section==='employees'" class="button button-primary" to="/references/employees">Добавить сотрудника</router-link>
        <template v-if="section==='schedule'"><button class="button" :disabled="saving||!point" @click="saveSchedule(false)">Сохранить</button><button class="button button-primary" :disabled="saving||!point" @click="saveSchedule(true)">Опубликовать</button></template>
        <template v-if="section==='payroll'"><button class="button" :disabled="saving" @click="calculatePayroll(false)">Рассчитать</button><button class="button button-primary" :disabled="saving||!payroll" @click="calculatePayroll(true)">Сохранить ведомость</button></template>
        <a v-if="section==='hr'" class="button button-primary" href="/app/employee-leave">Оформить отпуск</a>
      </template>
    </ListPageHeader>
    <SmartFilterBar v-model="filterModel" :fields="filterFields" :view-key="`team.${section}`" @apply="load" @reset="load" />
    <div v-if="error" class="team-error">{{ error }} <button @click="load">Повторить</button></div>
    <div v-if="loading" class="team-loading">Загружаем данные сотрудников…</div>
    <template v-else>
      <div class="team-stats">
        <article><span>Активные сотрудники</span><b>{{ data.counters.active_employees || 0 }}</b></article>
        <article><span>Точки в доступе</span><b>{{ data.counters.points || 0 }}</b></article>
        <article><span>Опубликовано графиков</span><b>{{ data.counters.published_schedules || 0 }}</b></article>
        <article><span>Активные игры</span><b>{{ data.counters.active_games || 0 }}</b></article>
      </div>

      <div v-if="section==='employees'" class="team-panel">
        <SmartDataTable :rows="data.employees" :columns="employeeColumns" view-key="team.employees" :selectable="false" empty-title="Сотрудников пока нет" empty-text="Создайте первую кадровую карточку." />
      </div>

      <div v-else-if="section==='schedule'" class="team-panel schedule-panel">
        <div class="panel-title"><div><h2>План и факт смен</h2><p>На каждый день назначьте ровно одну утреннюю и одну вечернюю смену. «У/В» назначает обе смены одному сотруднику.</p></div><span class="status">{{ schedule.status || "Новый" }}</span></div>
        <div v-if="!point" class="team-empty"><b>Выберите точку</b></div>
        <template v-else>
          <div class="coverage-summary" :class="{ warning: completeDays !== days.length }"><b>Заполнено {{ completeDays }} из {{ days.length }} дней</b><span v-if="completeDays !== days.length">Красным отмечены дни без полного покрытия.</span><span v-else>График заполнен полностью.</span></div>
          <div class="schedule-scroll">
            <table class="schedule-grid"><thead><tr><th class="employee-col">Сотрудник</th><th v-for="day in days" :key="day" :class="{ 'coverage-bad': !dayCoverage[day]?.ok }">{{ day }}</th><th>Часы</th></tr></thead>
            <tbody><tr v-for="employee in selectedPointEmployees" :key="employee.name"><th class="employee-col">{{ employee.employee_name }}</th>
              <td v-for="day in days" :key="day" :class="{ 'coverage-bad-soft': !dayCoverage[day]?.ok }"><select v-model="draft[cellKey(employee.name, day)]" :title="isoDate(day)"><option value="">—</option><option v-for="shift in baseShifts" :key="shift.name" :value="shift.name">{{ shift.shift_code }}</option><option v-if="baseShifts.length === 2" :value="BOTH">У/В</option></select></td>
              <td class="hours">{{ plannedHours[employee.name] || 0 }}</td>
            </tr></tbody>
            <tfoot><tr><th class="employee-col">Проверка дня</th><td v-for="day in days" :key="day" :class="{ 'coverage-ok': dayCoverage[day]?.ok, 'coverage-bad': !dayCoverage[day]?.ok }"><b>{{ dayCoverage[day]?.ok ? "✓" : "!" }}</b><small v-if="!dayCoverage[day]?.ok">У {{ dayCoverage[day]?.morning || 0 }} · В {{ dayCoverage[day]?.evening || 0 }}</small></td><td>{{ completeDays }}/{{ days.length }}</td></tr></tfoot></table>
          </div>
        </template>
        <div class="legend"><span v-for="shift in baseShifts" :key="shift.name"><b>{{ shift.shift_code }}</b> {{ shift.shift_name }} · {{ shift.paid_hours }} ч</span><span><b>У/В</b> обе смены у одного сотрудника</span></div>
      </div>

      <div v-else-if="section==='payroll'" class="team-panel">
        <div class="panel-title payroll-controls"><div><h2>Расчёт зарплаты</h2><p>Факт часов и личная выручка берутся из закрытых кассовых смен.</p></div><label>С <input v-model="payrollStart" type="date"></label><label>По <input v-model="payrollEnd" type="date"></label></div>
        <div v-if="!payroll" class="team-empty"><b>Выберите точку и период, затем нажмите «Рассчитать»</b><span>Сохранение создаёт ведомость без проведения выплаты.</span></div>
        <template v-else>
          <SmartDataTable :rows="payroll.rows" :columns="payrollColumns" view-key="team.payroll" :selectable="false" empty-title="Нет данных за период" />
          <div class="totals"><span>Начислено <b>{{ money(payroll.totals.gross) }}</b></span><span>НДФЛ <b>{{ money(payroll.totals.ndfl) }}</b></span><span>К выплате <b>{{ money(payroll.totals.net) }}</b></span><span>Полная стоимость <b>{{ money(payroll.totals.cost) }}</b></span></div>
          <p v-if="payroll.name" class="saved">Ведомость сохранена: {{ payroll.name }}</p>
        </template>
      </div>

      <div v-else-if="section==='bonuses'" class="team-panel">
        <div class="panel-title"><div><h2>Премии и игра</h2><p>Отзывы, регистрации клуба, подарки и средний чек рассчитываются из кассовых данных.</p></div></div>
        <div v-if="!data.motivation_periods.length" class="team-empty"><b>Активной игры пока нет</b></div>
        <div v-else class="game-list"><article v-for="game in data.motivation_periods" :key="game.name"><div><h3>{{ game.title }}</h3><p>{{ pointNames[game.business_point] }} · {{ game.start_date }} — {{ game.end_date }}</p></div><code>{{ game.rules_version }}</code><button class="button" :disabled="recalculating" @click="recalculate(game.name)">Пересчитать</button></article></div>
      </div>

      <div v-else class="team-panel">
        <div class="panel-title"><div><h2>Кадры и документы</h2><p>Трудоустройство, отпуска и кадровые документы сотрудников.</p></div><router-link class="button" to="/references/employees">Карточки сотрудников</router-link></div>
        <SmartDataTable :rows="hr.leaves" :columns="leaveColumns" view-key="team.hr.leaves" :selectable="false" empty-title="Отпусков пока нет" empty-text="Оформите отпуск, компенсацию или больничный." />
      </div>
    </template>
  </section>
</template>

<style scoped>
.team-page{display:grid;gap:18px}.team-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.team-stats article,.team-panel{border:1px solid #e1e6dc;border-radius:16px;background:#fff;box-shadow:0 8px 26px rgba(38,59,25,.06)}.team-stats article{padding:16px}.team-stats span{display:block;color:#71806a;font-size:13px}.team-stats b{display:block;margin-top:7px;font-size:27px;color:#284d1e}.team-panel{padding:20px;min-width:0}.panel-title{display:flex;justify-content:space-between;gap:18px;align-items:center;margin-bottom:16px}.panel-title h2,.game-list h3{margin:0 0 5px}.panel-title p,.game-list p{margin:0;color:#74806f}.team-empty{display:grid;place-items:center;min-height:190px;text-align:center;color:#7a8575}.team-empty b{color:#35452e;font-size:17px}.team-empty span{max-width:540px}.team-error,.team-loading{padding:16px;border-radius:12px;background:#fff}.status{padding:6px 10px;border-radius:999px;background:#eef6e8;color:#43772e}.schedule-scroll{overflow:auto;border:1px solid #e5e9e1;border-radius:12px}.schedule-grid{border-collapse:separate;border-spacing:0;min-width:1100px;width:100%;font-size:12px}.schedule-grid th,.schedule-grid td{border-right:1px solid #edf0e9;border-bottom:1px solid #edf0e9;padding:4px;text-align:center}.schedule-grid thead th{position:sticky;top:0;background:#f6f8f3;z-index:2}.schedule-grid .employee-col{position:sticky;left:0;min-width:190px;text-align:left;background:#fff;z-index:1;padding-left:10px}.schedule-grid thead .employee-col{z-index:3;background:#f6f8f3}.schedule-grid select{width:42px;height:32px;border:1px solid #d9e0d3;border-radius:6px;background:#fff}.schedule-grid .hours{font-weight:700}.schedule-grid tfoot th,.schedule-grid tfoot td{position:sticky;bottom:0;background:#f6f8f3;z-index:2}.schedule-grid tfoot .employee-col{z-index:3}.schedule-grid tfoot small{display:block;white-space:nowrap;font-size:9px}.coverage-bad{background:#ffe4e1!important;color:#a52b21}.coverage-bad-soft{background:#fff8f7}.coverage-ok{background:#eaf6e4!important;color:#357422}.coverage-summary{display:flex;gap:12px;align-items:center;margin:-4px 0 12px;padding:10px 12px;border-radius:10px;background:#edf7e8;color:#3d6f2a;font-size:13px}.coverage-summary.warning{background:#fff0ee;color:#9b3329}.legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;color:#6d7868;font-size:13px}.legend b{color:#355d23}.payroll-controls{justify-content:flex-start}.payroll-controls>div{margin-right:auto}.payroll-controls label{font-size:12px;color:#687462}.payroll-controls input{display:block;margin-top:4px;border:1px solid #dbe2d5;border-radius:8px;padding:8px}.totals{display:flex;justify-content:flex-end;gap:24px;flex-wrap:wrap;margin-top:15px;padding-top:15px;border-top:1px solid #e7ebe3}.totals span{color:#71806a}.totals b{display:block;color:#284d1e;font-size:18px}.saved{color:#397525;text-align:right}.game-list{display:grid;gap:10px}.game-list article{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px;border:1px solid #edf0e9;border-radius:12px}.game-list code{color:#67805b}@media(max-width:900px){.team-stats{grid-template-columns:repeat(2,1fr)}.panel-title{align-items:flex-start;flex-wrap:wrap}.payroll-controls>div{width:100%}}@media(max-width:560px){.team-stats{grid-template-columns:1fr}.team-panel{padding:14px}}
</style>
