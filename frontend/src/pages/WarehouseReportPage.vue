<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { call } from "../api";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";
import SmartDataTable from "../components/SmartDataTable.vue";

const route = useRoute();
const report = computed(() => route.meta.report);
const rows = ref([]), totals = ref({}), loading = ref(true), error = ref("");
const options = reactive({ points: [], warehouses: [], groups: [] });
const filters = reactive({ as_of: new Date().toISOString().slice(0,10), from_date: new Date().toISOString().slice(0,10), to_date: new Date().toISOString().slice(0,10), business_point: "", warehouse: "", catalog_group: "", search: "" });
const configs = {
  balances: { title: "Остатки", description: "Фактическое количество и стоимость товаров на выбранную дату" },
  turnover: { title: "Обороты", description: "Приход, расход и изменение запасов за период" },
};
const config = computed(() => configs[report.value]);
const balanceColumns = [c("item_name","Наименование",true),c("item_code","Код"),c("catalog_group","Группа"),c("warehouse_name","Склад"),c("storage_location","Адрес"),c("quantity","Остаток","qty"),c("expected_quantity","Ожидается","qty"),c("uom","Ед."),c("average_rate","Себестоимость","money"),c("stock_value","Стоимость остатка","money")];
const turnoverColumns = [c("item_name","Наименование",true),c("item_code","Код"),c("catalog_group","Группа"),c("warehouse_name","Склад"),c("opening_qty","Начальный остаток","qty"),c("incoming_qty","Приход","qty"),c("outgoing_qty","Расход","qty"),c("closing_qty","Конечный остаток","qty"),c("incoming_value","Приход, ₽","money"),c("outgoing_value","Расход, ₽","money"),c("closing_value","Стоимость остатка","money")];
const columns = computed(() => report.value === "balances" ? balanceColumns : turnoverColumns);
const visibleWarehouses = computed(() => options.warehouses.filter((row) => !filters.business_point || row.business_point === filters.business_point));
function c(key,label,primaryOrFormat=false,formatType=null){const primary=primaryOrFormat===true;const type=typeof primaryOrFormat==="string"?primaryOrFormat:formatType;return {key,label,primary,number:!!type,formatType:type,format:value=>formatValue(value,type)};}
function formatValue(value,type){ if(type==="money") return `${new Intl.NumberFormat("ru-RU",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value||0))} ₽`; if(type==="qty") return new Intl.NumberFormat("ru-RU",{maximumFractionDigits:3}).format(Number(value||0)); return value||"—"; }
const filterFields=computed(()=>[
  {key:"search",label:"Поиск",placeholder:"Название, код или артикул",wide:true},
  ...(report.value==="balances"?[{key:"as_of",label:"На дату",type:"date"}]:[{key:"from_date",label:"Период с",type:"date"},{key:"to_date",label:"Период по",type:"date"}]),
  {key:"business_point",label:"Точка",type:"select",allLabel:"Все точки",options:options.points.map(point=>({value:point.name,label:point.point_name}))},
  {key:"warehouse",label:"Склад",type:"select",allLabel:"Все склады",options:visibleWarehouses.value.map(row=>({value:row.name,label:row.warehouse_name}))},
  {key:"catalog_group",label:"Группа",type:"select",allLabel:"Все группы",options:options.groups.map(group=>({value:group.name,label:group.group_name}))},
]);

async function load(){loading.value=true;error.value="";try{const common={business_point:filters.business_point,warehouse:filters.warehouse,catalog_group:filters.catalog_group,search:filters.search};const isBalances=report.value==="balances";const method=isBalances?"get_stock_balances":"get_stock_turnover";const params=isBalances?{...common,as_of:filters.as_of}:{...common,from_date:filters.from_date,to_date:filters.to_date};const result=await call(`raspechatka.api.warehouse_reports.${method}`,params);rows.value=result.rows;totals.value=result.totals;}catch(e){error.value=e.message;}finally{loading.value=false;}}
async function loadOptions(){try{Object.assign(options,await call("raspechatka.api.warehouse_reports.get_report_options"));}catch(e){error.value=e.message;}}
function exportCsv(){const header=columns.value.map(column=>column.label);const data=rows.value.map(row=>columns.value.map(column=>row[column.key]??""));const csv=[header,...data].map(line=>line.map(value=>`"${String(value).replaceAll('"','""')}"`).join(";")).join("\n");const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"});const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=`${report.value}-${new Date().toISOString().slice(0,10)}.csv`;link.click();URL.revokeObjectURL(link.href);}
watch(report,load);onMounted(()=>Promise.all([loadOptions(),load()]));
</script>

<template><section class="page report-page"><ListPageHeader :title="config.title"><template #actions><button class="button button-secondary" @click="exportCsv">Экспорт CSV</button></template></ListPageHeader>
<SmartFilterBar :key="report" :model-value="filters" :fields="filterFields" :view-key="`warehouse.${report}`" @update:model-value="Object.assign(filters,$event)" @apply="load" @reset="load" />
<SmartDataTable :rows="rows" :columns="columns" :totals="totals" :view-key="`warehouse.${report}`" :loading="loading" :error="error" empty-title="Движений пока нет" empty-text="Проведите складской документ или измените фильтры." @retry="load" /></section></template>
