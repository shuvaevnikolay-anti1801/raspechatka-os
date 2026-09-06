<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { call, canAccess } from "../api";
import AppModal from "../components/AppModal.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";
import SmartDataTable from "../components/SmartDataTable.vue";

const route = useRoute();
const rows = ref([]), loading = ref(true), error = ref("");
const editorOpen = ref(false), saving = ref(false), formError = ref("");
const filters = ref({ search:"", receipt_type:"", status:"", business_point:"" });
const options = reactive({ entities: [], points: [], warehouses: [], suppliers: [], items: [], locations: [], storage_defaults: [] });
const form = reactive({});

const canEdit = computed(() => canAccess("warehouse.operations", "Edit"));
const visiblePoints = computed(() => options.points.filter((row) => !form.business_entity || row.business_entity === form.business_entity));
const visibleWarehouses = computed(() => options.warehouses.filter((row) => !form.business_point || row.business_point === form.business_point));
const visibleLocations = (row) => options.locations.filter((location) => location.warehouse === form.warehouse);
const totalQty = computed(() => (form.items || []).reduce((sum, row) => sum + Number(row.quantity || 0), 0));
const totalAmount = computed(() => (form.items || []).reduce((sum, row) => sum + Number(row.quantity || 0) * Number(row.rate || 0), 0));
const title = computed(() => `${form.receipt_type || "Приёмка"}${form.name ? ` № ${form.name}` : ""}`);
const filterFields = computed(()=>[
  {key:"search",label:"Поиск",placeholder:"Номер, поставщик или входящий документ",wide:true},
  {key:"receipt_type",label:"Тип",type:"select",allLabel:"Все типы",options:["Приёмка","Оприходование"].map(value=>({value,label:value}))},
  {key:"status",label:"Статус",type:"select",allLabel:"Все статусы",options:[{value:"0",label:"Черновики"},{value:"1",label:"Проведённые"},{value:"2",label:"Отменённые"}]},
  {key:"business_point",label:"Точка",type:"select",allLabel:"Все точки",options:options.points.map(point=>({value:point.name,label:point.point_name}))},
]);
const listColumns=[{key:"name",label:"Номер",primary:true,width:150},{key:"receipt_type",label:"Тип",width:140},{key:"posting_datetime",label:"Дата",format:dateTime,width:150},{key:"business_point",label:"Точка",format:pointLabel,width:180},{key:"supplier",label:"Поставщик",format:supplierLabel,width:190},{key:"total_quantity",label:"Количество",number:true},{key:"total_amount",label:"Сумма",format:value=>`${money(value)} ₽`,number:true},{key:"docstatus",label:"Статус",format:statusLabel,width:130}];
const listTotals=computed(()=>({total_quantity:rows.value.reduce((sum,row)=>sum+Number(row.total_quantity||0),0),total_amount:rows.value.reduce((sum,row)=>sum+Number(row.total_amount||0),0)}));

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function money(value) { return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0)); }
function dateTime(value) { return value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value.replace(" ", "T"))) : "—"; }
function statusLabel(value) { return value === 1 ? "Проведён" : value === 2 ? "Отменён" : "Черновик"; }
function pointLabel(name) { return options.points.find((row) => row.name === name)?.point_name || name; }
function supplierLabel(name) { return options.suppliers.find((row) => row.name === name)?.supplier_name || name || "—"; }

async function load() {
  loading.value = true; error.value = "";
  try { rows.value = await call("raspechatka.api.warehouse.get_receipts", filters.value); }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}

async function loadOptions() {
  try { const result = await call("raspechatka.api.warehouse.get_receipt", { receipt_type: "Приёмка" }); Object.assign(options, result.options); }
  catch (e) { error.value = e.message; }
}

async function openReceipt(name = null, receiptType = "Приёмка", purchaseOrder = null) {
  formError.value = "";
  try {
    const result = await call("raspechatka.api.warehouse.get_receipt", { name, receipt_type: receiptType, purchase_order: purchaseOrder });
    Object.assign(options, result.options);
    Object.keys(form).forEach((key) => delete form[key]);
    Object.assign(form, clone(result.doc));
    if (form.posting_datetime) form.posting_datetime = String(form.posting_datetime).replace(" ", "T").slice(0, 16);
    form.items ||= [];
    for (const row of form.items) if (!row.storage_location) onItemChange(row);
    editorOpen.value = true;
  } catch (e) { error.value = e.message; }
}

function addLine() { form.items.push({ item: "", uom: "", storage_location: "", quantity: 1, rate: "" }); }
function removeLine(index) { form.items.splice(index, 1); }
function onItemChange(row) {
  const item = options.items.find((value) => value.name === row.item);
  row.uom = item?.stock_uom || "";
  const preferred = options.storage_defaults.find((value) => value.item === row.item && value.warehouse === form.warehouse);
  row.storage_location = preferred?.storage_location || "";
}
function onEntityChange() {
  if (!visiblePoints.value.some((row) => row.name === form.business_point)) form.business_point = "";
  onPointChange();
}
function onPointChange() {
  const warehouse = visibleWarehouses.value[0];
  form.warehouse = warehouse?.name || "";
  refreshAddresses();
}
function refreshAddresses() { for (const row of form.items || []) onItemChange(row); }

async function save(closeAfter = false, throwOnError = false) {
  saving.value = true; formError.value = "";
  try {
    const payload = { ...clone(form), total_quantity: totalQty.value, total_amount: totalAmount.value };
    const result = await call("raspechatka.api.warehouse.save_receipt", { data: JSON.stringify(payload) }, { method: "POST" });
    await load();
    if (closeAfter) editorOpen.value = false;
    else await openReceipt(result.name);
  } catch (e) { formError.value = e.message; if (throwOnError) throw e; }
  finally { saving.value = false; }
}
async function submit() {
  if (!confirm("Провести документ? После проведения строки нельзя будет изменять.")) return;
  saving.value = true; formError.value = "";
  try { await save(false, true); await call("raspechatka.api.warehouse.submit_receipt", { name: form.name }, { method: "POST" }); await Promise.all([load(), openReceipt(form.name)]); }
  catch (e) { formError.value = e.message; }
  finally { saving.value = false; }
}
async function cancel() {
  if (!confirm("Отменить документ? Остатки будут сторнированы.")) return;
  saving.value = true; formError.value = "";
  try { await call("raspechatka.api.warehouse.cancel_receipt", { name: form.name }, { method: "POST" }); await Promise.all([load(), openReceipt(form.name)]); }
  catch (e) { formError.value = e.message; }
  finally { saving.value = false; }
}

onMounted(async () => { await Promise.all([load(), loadOptions()]); if (route.query.receipt) await openReceipt(route.query.receipt); else if (route.query.purchase_order) await openReceipt(null, "Приёмка", route.query.purchase_order); });
</script>

<template>
  <section class="page warehouse-page">
    <ListPageHeader title="Приёмки и оприходования"><template #actions>
      <div v-if="canEdit" class="heading-actions">
        <button class="button button-secondary" @click="openReceipt(null, 'Оприходование')">＋ Оприходование</button>
        <button class="button button-primary" @click="openReceipt(null, 'Приёмка')">＋ Приёмка</button>
      </div>
    </template></ListPageHeader>
    <SmartFilterBar v-model="filters" :fields="filterFields" view-key="warehouse.receipts" @apply="load" @reset="load" />
    <SmartDataTable :rows="rows" :columns="listColumns" :totals="listTotals" view-key="warehouse.receipts" :loading="loading" :error="error" empty-title="Документов пока нет" empty-text="Создайте первую приёмку или оприходование" @open="openReceipt($event.name)" @retry="load"><template #cell-receipt_type="{row}"><span class="type-chip" :class="{service:row.receipt_type==='Оприходование'}">{{row.receipt_type}}</span></template><template #cell-docstatus="{row}"><span class="document-state" :class="`state-${row.docstatus}`">{{statusLabel(row.docstatus)}}</span></template></SmartDataTable>

    <AppModal v-if="editorOpen" :title="title" wide @close="editorOpen=false">
      <form class="receipt-form" @submit.prevent="save(false)">
        <div class="document-strip"><span class="document-state" :class="`state-${form.docstatus}`">{{ statusLabel(form.docstatus) }}</span><span v-if="form.name">{{ form.name }}</span><span v-else>Новый документ</span><span v-if="form.purchase_order">По заказу {{form.purchase_order}}</span></div>
        <div class="form-section"><h3>Основное</h3><div class="form-grid">
          <label>Тип документа<select v-model="form.receipt_type" :disabled="form.docstatus!==0||!!form.purchase_order"><option>Приёмка</option><option>Оприходование</option></select></label>
          <label>Дата и время<input v-model="form.posting_datetime" type="datetime-local" :disabled="form.docstatus!==0" required /></label>
          <label>Юридическое лицо<select v-model="form.business_entity" :disabled="form.docstatus!==0" required @change="onEntityChange"><option value="">Не выбрано</option><option v-for="entity in options.entities" :key="entity.name" :value="entity.name">{{ entity.short_name }}</option></select></label>
          <label>Точка продаж<select v-model="form.business_point" :disabled="form.docstatus!==0" required @change="onPointChange"><option value="">Не выбрано</option><option v-for="point in visiblePoints" :key="point.name" :value="point.name">{{ point.point_name }}</option></select></label>
          <label>Склад<select v-model="form.warehouse" :disabled="form.docstatus!==0" required @change="refreshAddresses"><option value="">Не выбрано</option><option v-for="warehouse in visibleWarehouses" :key="warehouse.name" :value="warehouse.name">{{ warehouse.warehouse_name }}</option></select></label>
          <template v-if="form.receipt_type==='Приёмка'">
            <label>Поставщик<select v-model="form.supplier" :disabled="form.docstatus!==0" required><option value="">Не выбрано</option><option v-for="supplier in options.suppliers" :key="supplier.name" :value="supplier.name">{{ supplier.supplier_name }}</option></select></label>
            <label>Номер документа поставщика<input v-model="form.supplier_document_number" :disabled="form.docstatus!==0" /></label>
            <label>Дата документа поставщика<input v-model="form.supplier_document_date" type="date" :disabled="form.docstatus!==0" /></label>
          </template>
          <label v-else class="span-2">Основание оприходования<input v-model="form.reason" :disabled="form.docstatus!==0" required placeholder="Например: обнаруженные излишки" /></label>
        </div></div>
        <div class="form-section receipt-items"><div class="section-heading"><div><h3>Товары</h3><small>Закупочная цена обязательна и формирует себестоимость</small></div><button v-if="form.docstatus===0" type="button" class="button button-secondary" @click="addLine">＋ Добавить товар</button></div>
          <div v-if="!(form.items||[]).length" class="line-empty">Добавьте товары из каталога</div>
          <div v-else class="receipt-lines">
            <div class="receipt-line receipt-line-head"><span>Товар</span><span>Ед.</span><span>Место хранения</span><span>Кол-во</span><span>Цена</span><span>Сумма</span><span></span></div>
            <div v-for="(row,index) in form.items" :key="row.name||index" class="receipt-line">
              <select v-model="row.item" :disabled="form.docstatus!==0||!!row.purchase_order_item" required @change="onItemChange(row)"><option value="">Выберите товар</option><option v-for="item in options.items" :key="item.name" :value="item.name">{{ item.item_code }} · {{ item.item_name }}</option></select>
              <span class="line-uom">{{ row.uom || '—' }}</span>
              <select v-model="row.storage_location" :disabled="form.docstatus!==0"><option value="">Без адреса</option><option v-for="location in visibleLocations(row)" :key="location.name" :value="location.name">{{ location.full_address || location.location_name }}</option></select>
              <input v-model.number="row.quantity" :disabled="form.docstatus!==0" type="number" min="0.001" step="0.001" required />
              <input v-model.number="row.rate" :disabled="form.docstatus!==0" type="number" min="0.01" step="0.01" required />
              <strong>{{ money(Number(row.quantity||0)*Number(row.rate||0)) }} ₽</strong>
              <button v-if="form.docstatus===0" type="button" aria-label="Удалить строку" @click="removeLine(index)">×</button>
            </div>
          </div>
        </div>
        <div class="receipt-bottom"><label>Комментарий<textarea v-model="form.remarks" rows="3" :disabled="form.docstatus!==0"></textarea></label><div class="receipt-totals"><span>Позиций <b>{{ (form.items||[]).length }}</b></span><span>Количество <b>{{ totalQty }}</b></span><strong>Итого <b>{{ money(totalAmount) }} ₽</b></strong></div></div>
        <p v-if="formError" class="form-error">{{ formError }}</p>
      </form>
      <template #footer><div><button v-if="form.docstatus===1&&canEdit" class="button button-secondary danger" :disabled="saving" @click="cancel">Отменить документ</button></div><div class="footer-actions"><button class="button button-secondary" @click="editorOpen=false">Закрыть</button><button v-if="form.docstatus===0&&canEdit" class="button button-secondary" :disabled="saving" @click="save(false)">{{ saving?'Сохраняем…':'Сохранить' }}</button><button v-if="form.docstatus===0&&form.name&&canEdit" class="button button-primary" :disabled="saving" @click="submit">Провести</button></div></template>
    </AppModal>
  </section>
</template>
