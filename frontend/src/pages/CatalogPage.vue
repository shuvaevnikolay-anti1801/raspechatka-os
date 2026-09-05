<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { call } from "../api";

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

function openItem(item) {
  window.location.href = `/app/catalog-item/${encodeURIComponent(item.name)}`;
}

function createItem(type) {
  window.location.href = `/app/catalog?create=${type}`;
}

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
      <div class="create-actions">
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
  </section>
</template>
