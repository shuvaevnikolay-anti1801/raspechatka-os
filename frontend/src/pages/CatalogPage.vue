<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { call, canAccess } from "../api";
import AppModal from "../components/AppModal.vue";

const items = ref([]);
const groups = ref([]);
const points = ref([]);
const loading = ref(true);
const error = ref("");
const search = ref("");
const itemType = ref("");
const catalogGroup = ref("");
const active = ref("");
const businessPoint = ref("");
let debounceTimer;
const editorOpen = ref(false);
const saving = ref(false);
const editorError = ref("");
const itemForm = reactive({});
const itemOptions = reactive({ groups: [], units: [], suppliers: [], price_types: [], items: [], points: [], warehouses: [] });
const canEdit = canAccess("references.catalog", "Edit");

const typeLabels = { Product: "Товар", Service: "Услуга", Bundle: "Комплект" };
const resultLabel = computed(() => {
  const count = items.value.length;
  return `${count} ${count === 1 ? "позиция" : count > 1 && count < 5 ? "позиции" : "позиций"}`;
});

async function loadItems() {
  loading.value = true;
  error.value = "";
  try {
    const result = await call("raspechatka.api.frontend.get_catalog_items", {
      search: search.value,
      item_type: itemType.value,
      catalog_group: catalogGroup.value,
      active: active.value,
      business_point: businessPoint.value,
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

function addPrice() { (itemForm.prices ||= []).push({ price_type: itemOptions.price_types[0]?.name || "", rate: 0, minimum_quantity: 1 }); }
function addBarcode() { (itemForm.barcodes ||= []).push({ barcode: "", barcode_type: "EAN-13", uom: itemForm.stock_uom, quantity: 1 }); }
function addRow(table, row) { (itemForm[table] ||= []).push(row); }
function removeRow(table, index) { itemForm[table].splice(index, 1); }

function resetFilters() {
  search.value = "";
  itemType.value = "";
  catalogGroup.value = "";
  active.value = "";
  businessPoint.value = "";
}

watch([itemType, catalogGroup, active, businessPoint], loadItems);
watch(search, () => {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(loadItems, 300);
});

onMounted(async () => {
  await Promise.all([loadFilters(), loadItems()]);
});
</script>

<template>
  <section class="page catalog-page">
    <div class="page-heading catalog-heading">
      <div>
        <div class="eyebrow">КАТАЛОГ</div>
        <h1>Товары и услуги</h1>
        <p>Единый каталог сети и ассортимент по точкам</p>
      </div>
      <div v-if="canEdit" class="create-actions">
        <button class="button button-secondary" type="button" @click="createItem('Service')">＋ Услуга</button>
        <button class="button button-secondary" type="button" @click="createItem('Bundle')">＋ Комплект</button>
        <button class="button button-primary" type="button" @click="createItem('Product')">＋ Создать товар</button>
      </div>
    </div>

    <div class="catalog-toolbar">
      <label class="search-field">
        <span>⌕</span>
        <input v-model="search" type="search" placeholder="Название, код или артикул" />
        <kbd>⌘ K</kbd>
      </label>
      <select v-model="itemType" aria-label="Тип позиции">
        <option value="">Все типы</option><option value="Product">Товары</option><option value="Service">Услуги</option><option value="Bundle">Комплекты</option>
      </select>
      <select v-model="catalogGroup" aria-label="Группа">
        <option value="">Все группы</option><option v-for="group in groups" :key="group.name" :value="group.name">{{ group.group_name }}</option>
      </select>
      <select v-model="active" aria-label="Активность">
        <option value="">Любой статус</option><option value="1">Активные</option><option value="0">Неактивные</option>
      </select>
      <select v-model="businessPoint" aria-label="Точка продаж">
        <option value="">Все точки</option><option v-for="point in points" :key="point.name" :value="point.name">{{ point.point_name }}</option>
      </select>
      <button class="filter-reset" type="button" @click="resetFilters" title="Сбросить фильтры">↺</button>
    </div>

    <div class="table-meta"><strong>{{ resultLabel }}</strong><span>Обновлено сейчас</span></div>
    <div class="table-shell">
      <div v-if="error" class="table-message error-message"><strong>Не удалось загрузить каталог</strong><span>{{ error }}</span><button @click="loadItems">Повторить</button></div>
      <div v-else-if="loading" class="table-message"><span class="loader"></span><span>Загружаем каталог…</span></div>
      <div v-else-if="!items.length" class="table-message"><strong>Ничего не найдено</strong><span>Измените фильтры или создайте новую позицию.</span></div>
      <table v-else>
        <thead><tr><th>Тип</th><th>Наименование</th><th>Код</th><th>Артикул</th><th>Группа</th><th>Ед. изм.</th><th>Статус</th><th></th></tr></thead>
        <tbody>
          <tr v-for="item in items" :key="item.name" tabindex="0" @click="openItem(item)" @keydown.enter="openItem(item)">
            <td><span class="type-chip" :class="item.item_type.toLowerCase()">{{ typeLabels[item.item_type] || item.item_type }}</span></td>
            <td class="item-name">{{ item.item_name }}</td><td>{{ item.item_code }}</td><td>{{ item.article || '—' }}</td><td>{{ item.catalog_group || '—' }}</td><td>{{ item.stock_uom }}</td>
            <td><span class="state" :class="{ inactive: !item.active }"><i></i>{{ item.active ? 'Активен' : 'Выключен' }}</span></td><td class="row-arrow">→</td>
          </tr>
        </tbody>
      </table>
    </div>
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
        <div class="form-section"><h3>Налоги и касса</h3><div class="form-grid"><label>НДС<select v-model="itemForm.vat_rate"><option>Без НДС</option><option>0%</option><option>5%</option><option>7%</option><option>10%</option><option>20%</option><option>22%</option></select></label><label>Система налогообложения<select v-model="itemForm.tax_system"><option>По настройке точки</option><option>ОСН</option><option>УСН Доход</option><option>УСН Доход минус расход</option><option>Патент</option></select></label><label>Предмет расчёта<select v-model="itemForm.receipt_subject"><option>Товар</option><option>Подакцизный товар</option><option>Работа</option><option>Услуга</option><option>Платёж</option><option>Иное</option></select></label></div></div>
        <p v-if="editorError" class="form-error">{{editorError}}</p>
      </form>
      <template #footer><span></span><div class="footer-actions"><button class="button button-secondary" @click="editorOpen=false">Закрыть</button><button v-if="canEdit" class="button button-primary" :disabled="saving" @click="saveItem">{{saving?'Сохраняем…':'Сохранить'}}</button></div></template>
    </AppModal>
  </section>
</template>
