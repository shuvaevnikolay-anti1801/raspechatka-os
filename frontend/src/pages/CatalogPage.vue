<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { call, canAccess } from "../api";
import AppModal from "../components/AppModal.vue";
import CatalogGroupSidebar from "../components/CatalogGroupSidebar.vue";
import ListPageHeader from "../components/ListPageHeader.vue";
import SmartDataTable from "../components/SmartDataTable.vue";
import SmartFilterBar from "../components/SmartFilterBar.vue";

const items = ref([]);
const groups = ref([]);
const points = ref([]);
const loading = ref(true);
const error = ref("");
const filters = reactive({ search: "", item_type: "", catalog_group: "", active: "", business_point: "" });
const editorOpen = ref(false);
const saving = ref(false);
const editorError = ref("");
const itemForm = reactive({});
const itemOptions = reactive({ groups: [], units: [], suppliers: [], price_types: [], items: [], points: [], warehouses: [] });
const canEdit = canAccess("references.catalog", "Edit");
const groupEditorOpen = ref(false);
const groupSaving = ref(false);
const groupError = ref("");
const groupForm = reactive({ name: "", group_name: "", parent_catalog_group: "", description: "", active: 1, is_group: 0 });

const typeLabels = { Product: "Товар", Service: "Услуга", Bundle: "Комплект" };
const filterFields = computed(() => [
  { key: "search", label: "Название, код или артикул", placeholder: "Введите текст", wide: true },
  { key: "item_type", label: "Тип", type: "select", options: [{ value: "Product", label: "Товар" }, { value: "Service", label: "Услуга" }, { value: "Bundle", label: "Комплект" }] },
  { key: "active", label: "Статус", type: "select", options: [{ value: "1", label: "Активные" }, { value: "0", label: "Неактивные" }] },
  { key: "business_point", label: "Точка продаж", type: "select", options: points.value.map((point) => ({ value: point.name, label: point.point_name })) },
]);
const tableColumns = computed(() => [
  { key: "item_type", label: "Тип", width: 120, format: (value) => typeLabels[value] || value },
  { key: "item_name", label: "Наименование", primary: true, width: 280 },
  { key: "item_code", label: "Код", width: 130 },
  { key: "article", label: "Артикул", width: 140 },
  { key: "catalog_group", label: "Группа", width: 180 },
  { key: "stock_uom", label: "Ед. изм.", width: 110 },
  { key: "minimum_sale_price", label: "Мин. цена", width: 120, format: (value) => value ? Number(value).toLocaleString("ru-RU", { minimumFractionDigits: 2 }) : "—" },
  { key: "active", label: "Статус", width: 120, format: (value) => value ? "Активен" : "Выключен" },
]);

async function loadItems() {
  loading.value = true;
  error.value = "";
  try {
    const result = await call("raspechatka.api.frontend.get_catalog_items", {
      ...filters,
    });
    items.value = result.items || [];
  } catch (exception) {
    error.value = exception.message;
  } finally {
    loading.value = false;
  }
}

async function loadFilters() {
  try {
    const result = await call("raspechatka.api.frontend.get_catalog_filters");
    groups.value = result.groups || [];
    points.value = result.business_points || [];
  } catch (exception) {
    error.value = exception.message;
  }
}

async function openItem(item) {
  await loadEditor(item.name);
}

async function createItem(type) {
  await loadEditor(null, type);
}

async function loadEditor(name, type = "Product") {
  editorError.value = "";
  try {
    const result = await call("raspechatka.api.frontend.get_catalog_item", { name, item_type: type });
    Object.keys(itemForm).forEach((key) => delete itemForm[key]);
    Object.assign(itemForm, JSON.parse(JSON.stringify(result.doc)));
    Object.assign(itemOptions, result.options);
    editorOpen.value = true;
  } catch (exception) { error.value = exception.message; }
}

async function saveItem() {
  saving.value = true; editorError.value = "";
  try {
    const result = await call("raspechatka.api.frontend.save_catalog_item", { data: JSON.stringify(itemForm) }, { method: "POST" });
    await loadItems();
    await loadEditor(result.name);
  } catch (exception) { editorError.value = exception.message; }
  finally { saving.value = false; }
}

async function selectGroup(name) {
  filters.catalog_group = name;
  await loadItems();
}

function openGroupEditor(group = null) {
  groupError.value = "";
  Object.assign(groupForm, group
    ? { name: group.name, group_name: group.group_name, parent_catalog_group: group.parent_catalog_group || "", description: group.description || "", active: group.active ?? 1, is_group: group.is_group || 0 }
    : { name: "", group_name: "", parent_catalog_group: filters.catalog_group || "", description: "", active: 1, is_group: 0 });
  groupEditorOpen.value = true;
}

async function saveGroup() {
  groupSaving.value = true;
  groupError.value = "";
  try {
    const result = await call("raspechatka.api.frontend.save_catalog_group", { data: JSON.stringify(groupForm) }, { method: "POST" });
    await loadFilters();
    filters.catalog_group = result.name;
    groupEditorOpen.value = false;
    await loadItems();
  } catch (exception) {
    groupError.value = exception.message;
  } finally {
    groupSaving.value = false;
  }
}

function addPrice() { (itemForm.prices ||= []).push({ price_type: itemOptions.price_types[0]?.name || "", rate: 0, minimum_quantity: 1 }); }
function addBarcode() { (itemForm.barcodes ||= []).push({ barcode: "", barcode_type: "EAN-13", uom: itemForm.stock_uom, quantity: 1 }); }
function addRow(table, row) { (itemForm[table] ||= []).push(row); }
function removeRow(table, index) { itemForm[table].splice(index, 1); }

onMounted(async () => {
  await Promise.all([loadFilters(), loadItems()]);
});
</script>

<template>
  <section class="page catalog-page">
    <ListPageHeader title="Товары и услуги">
      <template #actions><div v-if="canEdit" class="create-actions">
        <button class="button button-secondary" type="button" @click="createItem('Service')">＋ Услуга</button>
        <button class="button button-secondary" type="button" @click="createItem('Bundle')">＋ Комплект</button>
        <button class="button button-primary" type="button" @click="createItem('Product')">＋ Создать товар</button>
      </div></template>
    </ListPageHeader>
    <div class="catalog-workspace">
      <CatalogGroupSidebar :groups="groups" :selected="filters.catalog_group" :can-edit="canEdit" @select="selectGroup" @create="openGroupEditor" @edit="openGroupEditor" />
      <div class="catalog-main">
    <SmartFilterBar :model-value="filters" :fields="filterFields" view-key="catalog.items" @update:model-value="Object.assign(filters,$event)" @apply="loadItems" @reset="loadItems" />
    <SmartDataTable :rows="items" :columns="tableColumns" view-key="catalog.items" :loading="loading" :error="error" empty-title="Ничего не найдено" empty-text="Измените фильтры или создайте новую позицию." @open="openItem" @retry="loadItems">
      <template #cell-item_type="{ row }"><span class="type-chip" :class="row.item_type.toLowerCase()">{{ typeLabels[row.item_type] || row.item_type }}</span></template>
      <template #cell-active="{ row }"><span class="state" :class="{ inactive: !row.active }"><i></i>{{ row.active ? 'Активен' : 'Выключен' }}</span></template>
    </SmartDataTable>
      </div>
    </div>
    <AppModal v-if="groupEditorOpen" :title="groupForm.name ? 'Группа каталога' : 'Новая группа'" @close="groupEditorOpen = false">
      <form class="editor-form" @submit.prevent="saveGroup">
        <div class="form-section"><div class="form-grid">
          <label class="span-2">Название<input v-model="groupForm.group_name" required autofocus /></label>
          <label>Родительская группа<select v-model="groupForm.parent_catalog_group"><option value="">Верхний уровень</option><option v-for="g in groups.filter(g => g.name !== groupForm.name)" :key="g.name" :value="g.name">{{ g.group_name }}</option></select></label>
          <label class="check-field"><input v-model="groupForm.active" type="checkbox" :true-value="1" :false-value="0" /> Активна</label>
          <label class="span-3">Описание<textarea v-model="groupForm.description" rows="3"></textarea></label>
        </div></div>
        <p v-if="groupError" class="form-error">{{ groupError }}</p>
      </form>
      <template #footer><span></span><div class="footer-actions"><button class="button button-secondary" @click="groupEditorOpen=false">Отмена</button><button class="button button-primary" :disabled="groupSaving" @click="saveGroup">{{groupSaving?'Сохраняем…':'Сохранить группу'}}</button></div></template>
    </AppModal>
    <AppModal v-if="editorOpen" :title="itemForm.item_name || 'Новая позиция'" wide @close="editorOpen = false">
      <form class="editor-form catalog-editor" @submit.prevent="saveItem">
        <div class="form-section"><h3>Основное</h3><div class="form-grid">
          <label>Тип<select v-model="itemForm.item_type"><option value="Product">Товар</option><option value="Service">Услуга</option><option value="Bundle">Комплект</option></select></label>
          <label>Код<input v-model="itemForm.item_code" required /></label><label class="check-field"><input v-model="itemForm.active" type="checkbox" :true-value="1" :false-value="0" /> Активен</label>
          <label class="span-2">Наименование<input v-model="itemForm.item_name" required /></label><label>Артикул<input v-model="itemForm.article" /></label>
          <label>Группа<select v-model="itemForm.catalog_group"><option value="">Не выбрана</option><option v-for="g in itemOptions.groups" :key="g.name" :value="g.name">{{g.group_name}}</option></select></label>
          <label>Единица<select v-model="itemForm.stock_uom" required><option v-for="u in itemOptions.units" :key="u.name" :value="u.name">{{u.unit_name}}</option></select></label>
          <label>Основной поставщик<select v-model="itemForm.default_supplier"><option value="">Не выбран</option><option v-for="s in itemOptions.suppliers" :key="s.name" :value="s.name">{{s.supplier_name}}</option></select></label>
          <label class="span-3">Описание<textarea v-model="itemForm.description" rows="3"></textarea></label>
        </div></div>
        <div class="form-section"><h3>Параметры</h3><div class="form-grid"><label>Бренд<input v-model="itemForm.brand" /></label><label>Страна происхождения<input v-model="itemForm.country_of_origin" /></label><label>Внешний код<input v-model="itemForm.external_code" /></label><label>Цвет<input v-model="itemForm.color" /></label><label>Размер<input v-model="itemForm.size" /></label><label>Вес, кг<input v-model.number="itemForm.weight" type="number" min="0" step="any" /></label><label>Объём, м³<input v-model.number="itemForm.volume" type="number" min="0" step="any" /></label></div></div>
        <div class="form-section"><div class="section-heading"><h3>Цены</h3><button v-if="canEdit" class="text-button" type="button" @click="addPrice">＋ Добавить цену</button></div><div class="form-grid"><label>Минимальная цена продажи<input v-model.number="itemForm.minimum_sale_price" type="number" min="0" step="0.01" /></label><label class="check-field"><input v-model="itemForm.prevent_discounts" type="checkbox" :true-value="1" :false-value="0" /> Запретить скидки</label></div><div class="editable-rows wide-rows"><div v-for="(row,index) in itemForm.prices" :key="index"><select v-model="row.price_type"><option v-for="p in itemOptions.price_types" :key="p.name" :value="p.name">{{p.price_type_name}}</option></select><input v-model.number="row.rate" type="number" min="0" step="0.01" placeholder="Цена" /><input v-model.number="row.minimum_quantity" type="number" min="0" step="any" placeholder="От количества" /><input v-model="row.valid_from" type="date" title="Действует с" /><input v-model="row.valid_upto" type="date" title="Действует до" /><button type="button" @click="removeRow('prices',index)">×</button></div></div></div>
        <div v-if="itemForm.item_type==='Product'" class="form-section"><h3>Складской учёт</h3><div class="form-grid"><label class="check-field"><input v-model="itemForm.track_inventory" type="checkbox" :true-value="1" :false-value="0" /> Учитывать остатки</label><label>Оценка<select v-model="itemForm.valuation_method"><option>Moving Average</option><option>FIFO</option></select></label><label class="check-field"><input v-model="itemForm.allow_negative_stock" type="checkbox" :true-value="1" :false-value="0" /> Разрешить минус</label><label>Прослеживаемость<select v-model="itemForm.tracking_method"><option value="None">Нет</option><option value="Batch">Партии</option><option value="Serial">Серийные номера</option></select></label><label>Срок годности, дней<input v-model.number="itemForm.shelf_life_days" type="number" min="0" /></label><label>Срок поставки, дней<input v-model.number="itemForm.lead_time_days" type="number" min="0" /></label><label>Минимальная партия<input v-model.number="itemForm.minimum_order_qty" type="number" min="0" step="any" /></label></div></div>
        <div v-if="itemForm.item_type==='Product'" class="form-section"><div class="section-heading"><h3>Правила пополнения</h3><button v-if="canEdit" class="text-button" type="button" @click="addRow('reorder_rules',{warehouse:'',minimum_stock:0,reorder_quantity:0,preferred_supplier:''})">＋ Добавить</button></div><div class="editable-rows wide-rows"><div v-for="(row,index) in itemForm.reorder_rules" :key="index"><select v-model="row.warehouse"><option value="">Склад</option><option v-for="w in itemOptions.warehouses" :key="w.name" :value="w.name">{{w.warehouse_name}}</option></select><input v-model.number="row.minimum_stock" type="number" min="0" placeholder="Минимум" /><input v-model.number="row.reorder_quantity" type="number" min="0" placeholder="Пополнение" /><select v-model="row.preferred_supplier"><option value="">Поставщик</option><option v-for="s in itemOptions.suppliers" :key="s.name" :value="s.name">{{s.supplier_name}}</option></select><button type="button" @click="removeRow('reorder_rules',index)">×</button></div></div></div>
        <div class="form-section"><div class="section-heading"><h3>Штрихкоды</h3><button v-if="canEdit" class="text-button" type="button" @click="addBarcode">＋ Добавить</button></div><div class="editable-rows wide-rows"><div v-for="(row,index) in itemForm.barcodes" :key="index"><input v-model="row.barcode" placeholder="Штрихкод" /><select v-model="row.barcode_type"><option>EAN-13</option><option>EAN-8</option><option>UPC-A</option><option>GTIN</option><option>GTIN-14</option><option>CODE-39</option><option>Data Matrix</option><option>QR</option><option>Other</option></select><select v-model="row.uom"><option value="">Единица</option><option v-for="u in itemOptions.units" :key="u.name" :value="u.name">{{u.unit_name}}</option></select><input v-model.number="row.quantity" type="number" min="0" step="any" placeholder="Количество" /><button type="button" @click="removeRow('barcodes',index)">×</button></div></div></div>
        <div class="form-section"><div class="section-heading"><h3>Упаковки</h3><button v-if="canEdit" class="text-button" type="button" @click="addRow('packaging',{package_name:'',uom:itemForm.stock_uom,quantity:1,barcode:'',weight:0})">＋ Добавить</button></div><div class="editable-rows wide-rows"><div v-for="(row,index) in itemForm.packaging" :key="index"><input v-model="row.package_name" placeholder="Упаковка" /><select v-model="row.uom"><option v-for="u in itemOptions.units" :key="u.name" :value="u.name">{{u.unit_name}}</option></select><input v-model.number="row.quantity" type="number" min="0" step="any" placeholder="Количество" /><input v-model="row.barcode" placeholder="Штрихкод" /><input v-model.number="row.weight" type="number" min="0" step="any" placeholder="Вес, кг" /><button type="button" @click="removeRow('packaging',index)">×</button></div></div></div>
        <div v-if="itemForm.item_type==='Bundle'" class="form-section"><div class="section-heading"><h3>Состав комплекта</h3><button v-if="canEdit" class="text-button" type="button" @click="addRow('bundle_components',{item:'',quantity:1,uom:'',notes:''})">＋ Компонент</button></div><div class="editable-rows wide-rows"><div v-for="(row,index) in itemForm.bundle_components" :key="index"><select v-model="row.item"><option value="">Товар или услуга</option><option v-for="i in itemOptions.items" :key="i.name" :value="i.name">{{i.item_name}}</option></select><input v-model.number="row.quantity" type="number" min="0" step="any" placeholder="Количество" /><select v-model="row.uom"><option value="">Единица</option><option v-for="u in itemOptions.units" :key="u.name" :value="u.name">{{u.unit_name}}</option></select><input v-model="row.notes" placeholder="Комментарий" /><button type="button" @click="removeRow('bundle_components',index)">×</button></div></div></div>
        <div class="form-section"><div class="section-heading"><h3>Характеристики</h3><button v-if="canEdit" class="text-button" type="button" @click="addRow('attributes',{attribute_name:'',attribute_value:''})">＋ Добавить</button></div><div class="editable-rows"><div v-for="(row,index) in itemForm.attributes" :key="index"><input v-model="row.attribute_name" placeholder="Характеристика" /><input v-model="row.attribute_value" placeholder="Значение" /><span></span><button type="button" @click="removeRow('attributes',index)">×</button></div></div></div>
        <div class="form-section"><div class="section-heading"><h3>Аналоги</h3><button v-if="canEdit" class="text-button" type="button" @click="addRow('analogues',{item:'',priority:1,notes:''})">＋ Добавить</button></div><div class="editable-rows"><div v-for="(row,index) in itemForm.analogues" :key="index"><select v-model="row.item"><option value="">Аналог</option><option v-for="i in itemOptions.items" :key="i.name" :value="i.name">{{i.item_name}}</option></select><input v-model.number="row.priority" type="number" min="0" placeholder="Приоритет" /><input v-model="row.notes" placeholder="Комментарий" /><button type="button" @click="removeRow('analogues',index)">×</button></div></div></div>
        <div class="form-section"><div class="section-heading"><h3>Ассортимент по точкам</h3><button v-if="canEdit" class="text-button" type="button" @click="addRow('assortments',{business_point:'',enabled:1,visible_in_pos:1,local_sale_price:null,default_warehouse:''})">＋ Точка</button></div><div class="editable-rows wide-rows"><div v-for="(row,index) in itemForm.assortments" :key="index"><select v-model="row.business_point"><option value="">Точка продаж</option><option v-for="p in itemOptions.points" :key="p.name" :value="p.name">{{p.point_name}}</option></select><label class="check-field"><input v-model="row.enabled" type="checkbox" :true-value="1" :false-value="0" /> Доступен</label><label class="check-field"><input v-model="row.visible_in_pos" type="checkbox" :true-value="1" :false-value="0" /> На кассе</label><input v-model.number="row.local_sale_price" type="number" min="0" step="0.01" placeholder="Своя цена" /><select v-model="row.default_warehouse"><option value="">Склад</option><option v-for="w in itemOptions.warehouses.filter(w=>!row.business_point||w.business_point===row.business_point)" :key="w.name" :value="w.name">{{w.warehouse_name}}</option></select><button type="button" @click="removeRow('assortments',index)">×</button></div></div></div>
        <div class="form-section"><h3>Налоги и касса</h3><div class="form-grid"><label>НДС<select v-model="itemForm.vat_rate"><option>Без НДС</option><option>0%</option><option>5%</option><option>7%</option><option>10%</option><option>18%</option><option>20%</option><option>22%</option></select></label><label>Система налогообложения<select v-model="itemForm.tax_system"><option>По настройке точки</option><option>ОСН</option><option>УСН Доход</option><option>УСН Доход минус расход</option><option>Патент</option></select></label><label>Предмет расчёта<select v-model="itemForm.receipt_subject"><option>Товар</option><option>Подакцизный товар</option><option>Работа</option><option>Услуга</option><option>Платёж</option><option>Иное</option></select></label></div></div>
        <p v-if="editorError" class="form-error">{{editorError}}</p>
      </form>
      <template #footer><span></span><div class="footer-actions"><button class="button button-secondary" @click="editorOpen=false">Закрыть</button><button v-if="canEdit" class="button button-primary" :disabled="saving" @click="saveItem">{{saving?'Сохраняем…':'Сохранить'}}</button></div></template>
    </AppModal>
  </section>
</template>

<style scoped>
.catalog-workspace { display: flex; align-items: flex-start; gap: 16px; min-width: 0; }
.catalog-main { flex: 1; min-width: 0; display: grid; gap: 12px; }
@media (max-width: 900px) { .catalog-workspace { flex-direction: column; } }
</style>
