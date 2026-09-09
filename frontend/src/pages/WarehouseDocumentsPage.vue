<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { call, canAccess } from "../api";
import AppModal from "../components/AppModal.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";
import SmartDataTable from "../components/SmartDataTable.vue";

const route = useRoute(), router = useRouter();
const kind = computed(() => route.meta.kind);
const configs = {
  "write-offs": { title: "Списания", description: "Уменьшение фактических остатков", create: "Создать списание", singular: "Списание", date: "posting_datetime" },
  inventories: { title: "Инвентаризации", description: "Сверка учётных и фактических остатков", create: "Создать инвентаризацию", singular: "Инвентаризация", date: "posting_datetime" },
  "purchase-orders": { title: "Заказы поставщикам", description: "Планирование поставок и контроль приёмки", create: "Создать заказ", singular: "Заказ поставщику", date: "order_date" },
};
const config = computed(() => configs[kind.value]);
const rows = ref([]), totalRows = ref(0), currentPage = ref(1), pageSize = ref(25), loading = ref(true), error = ref(""), editorOpen = ref(false), saving = ref(false), formError = ref(""), paymentName = ref(""), paymentAmount = ref(0), linkingPayment = ref(false);
const filters = ref({ search: "", status: "", business_point: "" });
const options = reactive({ entities: [], points: [], warehouses: [], suppliers: [], items: [], locations: [], storage_defaults: [] });
const form = reactive({});

const accessArea = computed(() => `page.warehouse.${kind.value.replaceAll("-", "_")}`);
const canEdit = computed(() => canAccess(accessArea.value, "Edit"));
const visiblePoints = computed(() => options.points.filter((row) => !form.business_entity || row.business_entity === form.business_entity));
const visibleWarehouses = computed(() => options.warehouses.filter((row) => !form.business_point || row.business_point === form.business_point));
const visibleLocations = computed(() => options.locations.filter((row) => row.warehouse === form.warehouse));
const totalQty = computed(() => (form.items || []).reduce((sum, row) => sum + Number(row.quantity ?? row.counted_quantity ?? 0), 0));
const totalAmount = computed(() => (form.items || []).reduce((sum, row) => sum + Number(row.amount ?? (Number(row.quantity || 0) * Number(row.rate || 0))), 0));
const inventorySurplus = computed(() => (form.items || []).reduce((sum, row) => sum + Math.max(Number(row.difference_amount ?? ((Number(row.counted_quantity||0)-Number(row.book_quantity||0))*Number(row.valuation_rate||0))), 0), 0));
const inventoryShortage = computed(() => Math.abs((form.items || []).reduce((sum, row) => sum + Math.min(Number(row.difference_amount ?? ((Number(row.counted_quantity||0)-Number(row.book_quantity||0))*Number(row.valuation_rate||0))), 0), 0)));
const filterFields = computed(() => [
  { key:"search", label:"Поиск", placeholder:"Номер или основание", wide:true },
  { key:"status", label:"Статус", type:"select", allLabel:"Все статусы", options:[{value:"0",label:"Черновики"},{value:"1",label:"Проведённые"},{value:"2",label:"Отменённые"}] },
  { key:"business_point", label:"Точка продаж", type:"select", allLabel:"Все точки", options:options.points.map(point=>({value:point.name,label:point.point_name})) },
]);
const listColumns = computed(() => {
  const columns = [
    {key:"name",label:"Номер",primary:true,width:150}, {key:config.value.date,label:"Дата",format:dateText,width:150},
    {key:"business_point",label:"Точка",format:pointLabel,width:190},
    kind.value==="purchase-orders" ? {key:"supplier",label:"Поставщик",format:supplierLabel,width:190} : {key:"reason",label:"Основание",width:240},
  ];
  if (kind.value==="inventories") columns.push({key:"surplus_amount",label:"Излишки",format:v=>`${money(v)} ₽`,number:true},{key:"shortage_amount",label:"Недостача",format:v=>`${money(v)} ₽`,number:true});
  else columns.push({key:"total_quantity",label:"Количество",number:true},{key:"total_amount",label:"Сумма",format:v=>`${money(v)} ₽`,number:true});
  if (kind.value==="purchase-orders") columns.push({key:"payment_status",label:"Оплата",width:150},{key:"outstanding_amount",label:"Долг",format:v=>`${money(v)} ₽`,number:true},{key:"payment_due_date",label:"Срок оплаты",format:dateText,width:130},{key:"order_status",label:"Поставка"});
  columns.push({key:"docstatus",label:"Статус",format:statusLabel,width:130}); return columns;
});
const listTotals = computed(() => kind.value==="inventories" ? {
  surplus_amount:rows.value.reduce((sum,row)=>sum+Number(row.surplus_amount||0),0), shortage_amount:rows.value.reduce((sum,row)=>sum+Number(row.shortage_amount||0),0),
} : { total_quantity:rows.value.reduce((sum,row)=>sum+Number(row.total_quantity||0),0), total_amount:rows.value.reduce((sum,row)=>sum+Number(row.total_amount||0),0), outstanding_amount:rows.value.reduce((sum,row)=>sum+Number(row.outstanding_amount||0),0) });

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function money(value) { return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0)); }
function dateText(value) { return value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", ...(String(value).includes(":") ? { timeStyle: "short" } : {}) }).format(new Date(String(value).replace(" ", "T"))) : "—"; }
function statusLabel(value) { return value === 1 ? "Проведён" : value === 2 ? "Отменён" : "Черновик"; }
function pointLabel(name) { return options.points.find((row) => row.name === name)?.point_name || name; }
function supplierLabel(name) { return options.suppliers.find((row) => row.name === name)?.supplier_name || name || "—"; }

async function load(page = 1, size = pageSize.value) {
  currentPage.value = page; pageSize.value = size;
  loading.value = true; error.value = "";
  try { const result = await call("raspechatka.api.warehouse_documents.get_documents", { kind: kind.value, ...filters.value, limit_start: (page - 1) * size, limit_page_length: size }); rows.value = result.rows || []; totalRows.value = Number(result.total || 0); }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}
async function loadOptions() { try { const result = await call("raspechatka.api.warehouse_documents.get_document", { kind: kind.value }); Object.assign(options, result.options); } catch (e) { error.value = e.message; } }
async function openDocument(name = null) {
  formError.value = "";
  try {
    const result = await call("raspechatka.api.warehouse_documents.get_document", { kind: kind.value, name });
    Object.assign(options, result.options); Object.keys(form).forEach((key) => delete form[key]); Object.assign(form, clone(result.doc));
    if (form.posting_datetime) form.posting_datetime = String(form.posting_datetime).replace(" ", "T").slice(0, 16);
    form.items ||= []; paymentName.value = ""; paymentAmount.value = 0; editorOpen.value = true;
  } catch (e) { error.value = e.message; }
}
function onEntityChange() { if (!visiblePoints.value.some((row) => row.name === form.business_point)) form.business_point = ""; onPointChange(); }
function onPointChange() { form.warehouse = visibleWarehouses.value[0]?.name || ""; refreshAddresses(); }
function refreshAddresses() { for (const row of form.items || []) setItemDefaults(row, true); }
function setItemDefaults(row, keepItem = false) {
  const item = options.items.find((value) => value.name === row.item); row.uom = item?.stock_uom || "";
  if (kind.value !== "purchase-orders") row.storage_location = options.storage_defaults.find((value) => value.item === row.item && value.warehouse === form.warehouse)?.storage_location || (keepItem ? row.storage_location : "");
}
function addLine() { form.items.push(kind.value === "inventories" ? { item: "", uom: "", storage_location: "", book_quantity: 0, counted_quantity: 0, valuation_rate: 0 } : { item: "", uom: "", storage_location: "", quantity: 1, rate: "" }); }
function removeLine(index) { form.items.splice(index, 1); }
async function fillInventory() {
  if (!form.warehouse) { formError.value = "Сначала выберите склад."; return; }
  try { form.items = await call("raspechatka.api.warehouse_documents.fill_inventory", { warehouse: form.warehouse, posting_datetime: form.posting_datetime }); if (!form.items.length) formError.value = "На складе пока нет учётных остатков."; }
  catch (e) { formError.value = e.message; }
}
async function save(rethrow = false) {
  saving.value = true; formError.value = "";
  try { const result = await call("raspechatka.api.warehouse_documents.save_document", { kind: kind.value, data: JSON.stringify(clone(form)) }, { method: "POST" }); await load(); await openDocument(result.name); return result.name; }
  catch (e) { formError.value = e.message; if (rethrow) throw e; }
  finally { saving.value = false; }
}
async function submit() {
  if (!confirm("Провести документ? После проведения его строки нельзя будет изменить.")) return;
  saving.value = true; formError.value = "";
  try { const name = await save(true); await call("raspechatka.api.warehouse_documents.submit_document", { kind: kind.value, name }, { method: "POST" }); await Promise.all([load(), openDocument(name)]); }
  catch (e) { formError.value = e.message; }
  finally { saving.value = false; }
}
async function cancel() {
  if (!confirm(kind.value === "purchase-orders" ? "Отменить заказ?" : "Отменить документ и сторнировать складские движения?")) return;
  saving.value = true; formError.value = "";
  try { await call("raspechatka.api.warehouse_documents.cancel_document", { kind: kind.value, name: form.name }, { method: "POST" }); await Promise.all([load(), openDocument(form.name)]); }
  catch (e) { formError.value = e.message; }
  finally { saving.value = false; }
}
function createReceipt() { editorOpen.value = false; router.push({ path: "/warehouse/receipts", query: { purchase_order: form.name } }); }
function openRelatedReceipt(name) { editorOpen.value = false; router.push({ path: "/warehouse/receipts", query: { receipt: name } }); }
function choosePayment() {
  const payment = (form.available_payments || []).find((row) => row.name === paymentName.value);
  paymentAmount.value = Math.min(Number(payment?.available_amount || 0), Number(form.outstanding_amount || 0));
}
async function linkPayment() {
  if (!paymentName.value || Number(paymentAmount.value) <= 0) { formError.value = "Выберите платёж и сумму зачёта."; return; }
  linkingPayment.value = true; formError.value = "";
  try {
    const result = await call("raspechatka.api.supplier_settlements.link_payment", { order_name: form.name, payment_name: paymentName.value, allocated_amount: paymentAmount.value }, { method: "POST" });
    Object.assign(form, result); paymentName.value = ""; paymentAmount.value = 0; await load();
  } catch (e) { formError.value = e.message; }
  finally { linkingPayment.value = false; }
}
async function unlinkPayment(allocation) {
  if (!confirm("Убрать платёж из расчёта этого заказа?")) return;
  linkingPayment.value = true; formError.value = "";
  try {
    const result = await call("raspechatka.api.supplier_settlements.unlink_payment", { order_name: form.name, allocation_name: allocation }, { method: "POST" });
    Object.assign(form, result); await load();
  } catch (e) { formError.value = e.message; }
  finally { linkingPayment.value = false; }
}
function resetPage() { editorOpen.value = false; filters.value = {search:"",status:"",business_point:""}; currentPage.value = 1; Promise.all([load(1), loadOptions()]); }
watch(kind, resetPage); onMounted(() => Promise.all([load(), loadOptions()]));
</script>

<template><section class="page warehouse-page"><ListPageHeader :title="config.title"><template #actions><button v-if="canEdit" class="button button-primary" @click="openDocument()">＋ {{ config.create }}</button></template></ListPageHeader>
<SmartFilterBar v-model="filters" :key="kind" :fields="filterFields" :view-key="`warehouse.${kind}`" @apply="load(1)" @reset="load(1)" />
<SmartDataTable :rows="rows" :columns="listColumns" :totals="listTotals" :view-key="`warehouse.${kind}`" :loading="loading" :error="error" :server-pagination="true" :total-rows="totalRows" :current-page="currentPage" @page-change="load" @page-size-change="load(1, $event)" empty-title="Документов пока нет" :empty-text="config.create" @open="openDocument($event.name)" @retry="load(currentPage)"><template #cell-docstatus="{row}"><span class="document-state" :class="`state-${row.docstatus}`">{{statusLabel(row.docstatus)}}</span></template></SmartDataTable>
<AppModal v-if="editorOpen" :title="`${config.singular}${form.name?' № '+form.name:''}`" wide @close="editorOpen=false"><form class="receipt-form" @submit.prevent="save()"><div class="document-strip"><span class="document-state" :class="`state-${form.docstatus}`">{{statusLabel(form.docstatus)}}</span><span>{{form.name||'Новый документ'}}</span><span v-if="kind==='purchase-orders'&&form.order_status">{{form.order_status}}</span></div><div class="form-section"><h3>Основное</h3><div class="form-grid">
<label v-if="kind==='purchase-orders'">Дата заказа<input v-model="form.order_date" type="date" :disabled="form.docstatus!==0" required /></label><label v-else>Дата и время<input v-model="form.posting_datetime" type="datetime-local" :disabled="form.docstatus!==0" required /></label><label v-if="kind==='purchase-orders'">Ожидаемая дата<input v-model="form.expected_date" type="date" :disabled="form.docstatus!==0" /></label>
<label>Юридическое лицо<select v-model="form.business_entity" :disabled="form.docstatus!==0" required @change="onEntityChange"><option value="">Не выбрано</option><option v-for="entity in options.entities" :key="entity.name" :value="entity.name">{{entity.short_name}}</option></select></label><label>Точка продаж<select v-model="form.business_point" :disabled="form.docstatus!==0" required @change="onPointChange"><option value="">Не выбрано</option><option v-for="point in visiblePoints" :key="point.name" :value="point.name">{{point.point_name}}</option></select></label><label>Склад<select v-model="form.warehouse" :disabled="form.docstatus!==0" required @change="refreshAddresses"><option value="">Не выбрано</option><option v-for="warehouse in visibleWarehouses" :key="warehouse.name" :value="warehouse.name">{{warehouse.warehouse_name}}</option></select></label>
<template v-if="kind==='purchase-orders'"><label>Поставщик<select v-model="form.supplier" :disabled="form.docstatus!==0" required><option value="">Не выбрано</option><option v-for="supplier in options.suppliers" :key="supplier.name" :value="supplier.name">{{supplier.supplier_name}}</option></select></label><label>Срок оплаты<input v-model="form.payment_due_date" type="date" :disabled="form.docstatus!==0" /></label><label>Статус оплаты<input :value="form.payment_status||'Не оплачено'" disabled /></label></template><label v-else class="span-2">Основание<input v-model="form.reason" :disabled="form.docstatus!==0" required /></label></div></div>
<div class="form-section receipt-items"><div class="section-heading"><div><h3>Товары</h3><small v-if="kind==='write-offs'">Себестоимость рассчитывается по текущему среднему значению</small><small v-else-if="kind==='inventories'">Введите фактическое количество после пересчёта</small><small v-else>Заказанное количество и закупочная цена</small></div><div v-if="form.docstatus===0" class="heading-actions"><button v-if="kind==='inventories'" type="button" class="button button-secondary" @click="fillInventory">Заполнить по остаткам</button><button type="button" class="button button-secondary" @click="addLine">＋ Добавить товар</button></div></div><div v-if="!form.items.length" class="line-empty">Добавьте товары</div><div v-else class="receipt-lines"><div class="receipt-line operation-line receipt-line-head" :class="kind"><span>Товар</span><span>Ед.</span><span v-if="kind!=='purchase-orders'">Место хранения</span><template v-if="kind==='inventories'"><span>По учёту</span><span>Фактически</span><span>Разница</span><span>Себестоимость</span></template><template v-else><span>Количество</span><span v-if="kind==='purchase-orders'">Принято</span><span>{{kind==='purchase-orders'?'Цена':'Себестоимость'}}</span></template><span>Сумма</span><span></span></div><div v-for="(row,index) in form.items" :key="row.name||index" class="receipt-line operation-line" :class="kind"><select v-model="row.item" :disabled="form.docstatus!==0" required @change="setItemDefaults(row)"><option value="">Выберите товар</option><option v-for="item in options.items" :key="item.name" :value="item.name">{{item.item_code}} · {{item.item_name}}</option></select><span class="line-uom">{{row.uom||'—'}}</span><select v-if="kind!=='purchase-orders'" v-model="row.storage_location" :disabled="form.docstatus!==0"><option value="">Без адреса</option><option v-for="location in visibleLocations" :key="location.name" :value="location.name">{{location.full_address||location.location_name}}</option></select><template v-if="kind==='inventories'"><span>{{row.book_quantity||0}}</span><input v-model.number="row.counted_quantity" type="number" min="0" step="0.001" :disabled="form.docstatus!==0" required /><strong>{{Number(row.counted_quantity||0)-Number(row.book_quantity||0)}}</strong><input v-model.number="row.valuation_rate" type="number" min="0" step="0.01" :disabled="form.docstatus!==0" /></template><template v-else><input v-model.number="row.quantity" type="number" min="0.001" step="0.001" :disabled="form.docstatus!==0" required /><span v-if="kind==='purchase-orders'">{{row.received_quantity||0}}</span><input v-if="kind==='purchase-orders'" v-model.number="row.rate" type="number" min="0.01" step="0.01" :disabled="form.docstatus!==0" required /><span v-else>{{money(row.valuation_rate)}} ₽</span></template><strong v-if="kind==='inventories'">{{money((Number(row.counted_quantity||0)-Number(row.book_quantity||0))*Number(row.valuation_rate||0))}} ₽</strong><strong v-else>{{money(row.amount??Number(row.quantity||0)*Number(row.rate||row.valuation_rate||0))}} ₽</strong><button v-if="form.docstatus===0" type="button" @click="removeLine(index)">×</button></div></div></div>
<div class="receipt-bottom"><label>Комментарий<textarea v-model="form.remarks" rows="3" :disabled="form.docstatus!==0"></textarea></label><div class="receipt-totals"><template v-if="kind==='inventories'"><span>Позиций <b>{{form.items.length}}</b></span><span>Излишки <b>{{money(inventorySurplus)}} ₽</b></span><strong>Недостача <b>{{money(inventoryShortage)}} ₽</b></strong></template><template v-else-if="kind==='purchase-orders'"><span>Заказ <b>{{money(totalAmount)}} ₽</b></span><span>Оплачено <b>{{money(form.paid_amount)}} ₽</b></span><strong>Долг <b>{{money(form.outstanding_amount??totalAmount)}} ₽</b></strong></template><template v-else><span>Позиций <b>{{form.items.length}}</b></span><span>Количество <b>{{totalQty}}</b></span><strong>Итого <b>{{money(totalAmount)}} ₽</b></strong></template></div></div>
<div v-if="kind==='purchase-orders'&&form.related_receipts?.length" class="form-section"><h3>Связанные приёмки</h3><div class="compact-list related-list"><div v-for="receipt in form.related_receipts" :key="receipt.name" @click="openRelatedReceipt(receipt.name)"><b>{{receipt.name}}</b><span>{{dateText(receipt.posting_datetime)}}</span><span>{{receipt.total_quantity}} · {{money(receipt.total_amount)}} ₽ →</span></div></div></div><div v-if="kind==='purchase-orders'&&form.docstatus===1" class="form-section"><div class="section-heading"><div><h3>Оплаты поставщику</h3><small>Можно связать несколько платежей или зачесть часть одного платежа</small></div></div><div v-if="canEdit&&form.outstanding_amount>0" class="form-grid"><label class="span-2">Платёж<select v-model="paymentName" @change="choosePayment"><option value="">Выберите проведённый платёж</option><option v-for="payment in form.available_payments||[]" :key="payment.name" :value="payment.name">{{dateText(payment.posting_date)}} · {{payment.counterparty_name||payment.purpose}} · доступно {{money(payment.available_amount)}} ₽</option></select></label><label>Зачесть<input v-model.number="paymentAmount" type="number" min="0.01" :max="form.outstanding_amount" step="0.01" /></label><button type="button" class="button button-secondary" :disabled="linkingPayment||!paymentName" @click="linkPayment">Связать платёж</button></div><div v-if="form.allocations?.length" class="compact-list related-list"><div v-for="allocation in form.allocations" :key="allocation.name"><b>{{allocation.finance_transaction}}</b><span>{{dateText(allocation.posting_date)}} · {{allocation.source}}</span><span>{{money(allocation.allocated_amount)}} ₽</span><button v-if="canEdit" type="button" :disabled="linkingPayment" @click="unlinkPayment(allocation.name)">×</button></div></div><div v-else class="line-empty">Связанных платежей пока нет</div></div><p v-if="formError" class="form-error">{{formError}}</p></form><template #footer><div><button v-if="form.docstatus===1&&canEdit" class="button button-secondary danger" :disabled="saving" @click="cancel">Отменить документ</button></div><div class="footer-actions"><button class="button button-secondary" @click="editorOpen=false">Закрыть</button><button v-if="kind==='purchase-orders'&&form.docstatus===1&&form.order_status!=='Принято'&&canEdit" class="button button-secondary" @click="createReceipt">Создать приёмку</button><button v-if="form.docstatus===0&&canEdit" class="button button-secondary" :disabled="saving" @click="save">{{saving?'Сохраняем…':'Сохранить'}}</button><button v-if="form.docstatus===0&&form.name&&canEdit" class="button button-primary" :disabled="saving" @click="submit">Провести</button></div></template></AppModal></section></template>
