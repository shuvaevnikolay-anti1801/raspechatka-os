<script setup>
import { computed, reactive, ref } from "vue";
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
const catalogPage = ref(1);
const catalogPageSize = ref(25);
const totalItems = ref(0);
const catalogReady = ref(false);
let itemsRequestId = 0;
const filters = reactive({ search: "", item_type: "", catalog_group: "", active: "", business_point: "" });
const editorOpen = ref(false);
const saving = ref(false);
const editorError = ref("");
const itemForm = reactive({});
const itemOptions = reactive({
	groups: [],
	units: [],
	suppliers: [],
	price_types: [],
	items: [],
	variant_parents: [],
	points: [],
	warehouses: [],
});
const canEdit = canAccess("references.catalog", "Edit");
const groupEditorOpen = ref(false);
const groupSaving = ref(false);
const groupError = ref("");
const groupForm = reactive({ name: "", group_name: "", parent_catalog_group: "", active: 1 });

const typeLabels = {
	Product: "Товар",
	Service: "Услуга",
	Bundle: "Комплект",
	Variant: "Модификация",
};
const inventoryType = computed(() => ["Product", "Variant"].includes(itemForm.item_type));
const currentVariants = computed(() =>
	itemOptions.items.filter((item) => item.variant_of === itemForm.name),
);
const groupOptions = computed(() => {
	const byParent = new Map();
	for (const group of itemOptions.groups) {
		const parent = group.parent_catalog_group || "";
		if (!byParent.has(parent)) byParent.set(parent, []);
		byParent.get(parent).push(group);
	}
	const result = [];
	const visit = (parent, depth) => {
		for (const group of byParent.get(parent) || []) {
			result.push({ ...group, label: "— ".repeat(depth) + group.group_name });
			visit(group.name, depth + 1);
		}
	};
	visit("", 0);
	return result;
});
const filterFields = computed(() => [
	{ key: "search", label: "Наименование", placeholder: "Введите название", wide: true },
	{
		key: "item_type",
		label: "Тип",
		type: "select",
		options: Object.entries(typeLabels).map(([value, label]) => ({ value, label })),
	},
	{
		key: "active",
		label: "Статус",
		type: "select",
		options: [
			{ value: "1", label: "Активные" },
			{ value: "0", label: "Архивные" },
		],
	},
	{
		key: "business_point",
		label: "Точка продаж",
		type: "select",
		options: points.value.map((point) => ({ value: point.name, label: point.point_name })),
	},
]);
const tableColumns = computed(() => [
	{ key: "item_type", label: "Тип", width: 130, format: (value) => typeLabels[value] || value },
	{ key: "item_name", label: "Наименование", primary: true, width: 330 },
	{ key: "catalog_group", label: "Группа", width: 220 },
	{ key: "variant_of", label: "Основной товар", width: 220 },
	{ key: "stock_uom", label: "Ед. изм.", width: 100 },
	{ key: "active", label: "Статус", width: 120, format: (value) => (value ? "Активен" : "В архиве") },
]);

async function loadItems() {
	const requestId = ++itemsRequestId;
	loading.value = true;
	error.value = "";
	try {
		const result = await call("raspechatka.api.frontend.get_catalog_items", {
			...filters,
			limit_start: (catalogPage.value - 1) * catalogPageSize.value,
			limit_page_length: catalogPageSize.value,
		});
		if (requestId !== itemsRequestId) return;
		items.value = result.items || [];
		totalItems.value = Number(result.total_count || 0);
	} catch (exception) {
		if (requestId === itemsRequestId) error.value = exception.message;
	} finally {
		if (requestId === itemsRequestId) loading.value = false;
	}
}

async function loadFilters(includeArchived = filters.active === "0") {
	const result = await call("raspechatka.api.frontend.get_catalog_filters", {
		include_archived: includeArchived ? 1 : 0,
	});
	groups.value = result.groups || [];
	points.value = result.business_points || [];
}

async function loadWorkspace() {
	error.value = "";
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await loadFilters();
			await loadItems();
			if (!error.value) return;
		} catch (exception) {
			error.value = exception.message;
			loading.value = false;
		}
		if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
	}
}

async function loadEditor(name, type = "Product") {
	editorError.value = "";
	try {
		const result = await call("raspechatka.api.frontend.get_catalog_item", { name, item_type: type });
		Object.keys(itemForm).forEach((key) => delete itemForm[key]);
		Object.assign(itemForm, JSON.parse(JSON.stringify(result.doc)));
		Object.assign(itemOptions, result.options);
		editorOpen.value = true;
	} catch (exception) {
		error.value = exception.message;
	}
}

async function saveItem() {
	saving.value = true;
	editorError.value = "";
	try {
		const result = await call(
			"raspechatka.api.frontend.save_catalog_item",
			{ data: JSON.stringify(itemForm) },
			{ method: "POST" },
		);
		await loadItems();
		await loadEditor(result.name);
	} catch (exception) {
		editorError.value = exception.message;
	} finally {
		saving.value = false;
	}
}

async function applyCatalogFilters() {
	catalogPage.value = 1;
	await loadFilters();
	await loadItems();
}

async function selectGroup(name) {
	filters.catalog_group = name;
	await applyCatalogFilters();
}

async function changeCatalogPage(nextPage, size = catalogPageSize.value) {
	catalogPage.value = nextPage;
	catalogPageSize.value = size;
	await loadItems();
}

async function changeCatalogPageSize(size) {
	catalogPage.value = 1;
	catalogPageSize.value = size;
	await loadItems();
}

function openGroupEditor(group = null) {
	groupError.value = "";
	Object.assign(
		groupForm,
		group
			? {
					name: group.name,
					group_name: group.group_name,
					parent_catalog_group: group.parent_catalog_group || "",
					active: group.active ?? 1,
				}
			: {
					name: "",
					group_name: "",
					parent_catalog_group: filters.catalog_group || "",
					active: 1,
				},
	);
	groupEditorOpen.value = true;
}

async function saveGroup() {
	groupSaving.value = true;
	groupError.value = "";
	try {
		const result = await call(
			"raspechatka.api.frontend.save_catalog_group",
			{ data: JSON.stringify(groupForm) },
			{ method: "POST" },
		);
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

async function changeItemArchiveState() {
	if (!itemForm.name) return;
	const archiving = Boolean(itemForm.active);
	if (archiving && !window.confirm("Перенести позицию в архив? Исторические документы сохранятся.")) return;
	saving.value = true;
	editorError.value = "";
	try {
		const method = archiving ? "archive_catalog_item" : "restore_catalog_item";
		await call("raspechatka.api.frontend." + method, { name: itemForm.name }, { method: "POST" });
		await loadItems();
		await loadEditor(itemForm.name);
	} catch (exception) {
		editorError.value = exception.message;
	} finally {
		saving.value = false;
	}
}

async function changeGroupArchiveState() {
	if (!groupForm.name) return;
	const archiving = Boolean(groupForm.active);
	if (archiving && !window.confirm("Перенести группу и все вложенные позиции в архив?")) return;
	groupSaving.value = true;
	groupError.value = "";
	try {
		const method = archiving ? "archive_catalog_group" : "restore_catalog_group";
		await call("raspechatka.api.frontend." + method, { name: groupForm.name }, { method: "POST" });
		groupEditorOpen.value = false;
		filters.catalog_group = "";
		await loadWorkspace();
	} catch (exception) {
		groupError.value = exception.message;
	} finally {
		groupSaving.value = false;
	}
}

function addPrice() {
	(itemForm.prices ||= []).push({
		price_type: itemOptions.price_types[0]?.name || "",
		business_point: "",
		uom: itemForm.stock_uom,
		currency: "RUB",
		rate: 0,
		minimum_quantity: 1,
	});
}

function addVariantValue() {
	(itemForm.variant_values ||= []).push({ attribute_name: "", attribute_value: "" });
}

function addBundleComponent() {
	(itemForm.bundle_components ||= []).push({ item: "", quantity: 1, uom: "шт", notes: "" });
}

function removeRow(table, index) {
	itemForm[table].splice(index, 1);
}

function selectVariantParent() {
	const parent = itemOptions.variant_parents.find((item) => item.name === itemForm.variant_of);
	if (!parent) return;
	itemForm.catalog_group = parent.catalog_group || "";
	itemForm.stock_uom = parent.stock_uom || "шт";
	itemForm.default_supplier = parent.default_supplier || "";
}

async function createVariantFrom(parent) {
	await loadEditor(null, "Variant");
	itemForm.variant_of = parent;
	selectVariantParent();
}

async function initializeCatalog(size) {
	if (catalogReady.value) return;
	catalogReady.value = true;
	catalogPageSize.value = Number(size) || 25;
	await loadWorkspace();
}
</script>

<template>
	<section class="page catalog-page">
		<ListPageHeader title="Товары и услуги">
			<template #actions>
				<div v-if="canEdit" class="create-actions">
					<button class="button button-secondary" type="button" @click="loadEditor(null, 'Service')">＋ Услуга</button>
					<button class="button button-secondary" type="button" @click="loadEditor(null, 'Bundle')">＋ Комплект</button>
					<button class="button button-secondary" type="button" @click="loadEditor(null, 'Variant')">＋ Модификация</button>
					<button class="button button-primary" type="button" @click="loadEditor(null, 'Product')">＋ Создать товар</button>
				</div>
			</template>
		</ListPageHeader>

		<div class="catalog-workspace">
			<CatalogGroupSidebar
				:groups="groups"
				:selected="filters.catalog_group"
				:can-edit="canEdit"
				@select="selectGroup"
				@create="openGroupEditor"
				@edit="openGroupEditor"
			/>
			<div class="catalog-main">
				<SmartFilterBar
					:model-value="filters"
					:fields="filterFields"
					view-key="catalog.items"
					@update:model-value="Object.assign(filters, $event)"
					@apply="applyCatalogFilters"
					@reset="applyCatalogFilters"
				/>
				<SmartDataTable
					:rows="items"
					:columns="tableColumns"
					view-key="catalog.items"
					:loading="loading"
					:error="error"
					server-pagination
					:total-rows="totalItems"
					:current-page="catalogPage"
					empty-title="Ничего не найдено"
					empty-text="Измените фильтры или создайте новую позицию."
					@open="(row) => loadEditor(row.name)"
					@retry="loadWorkspace"
					@ready="initializeCatalog"
					@page-change="changeCatalogPage"
					@page-size-change="changeCatalogPageSize"
				>
					<template #cell-item_type="{ row }"><span class="type-chip" :class="row.item_type.toLowerCase()">{{ typeLabels[row.item_type] || row.item_type }}</span></template>
					<template #cell-active="{ row }"><span class="state" :class="{ inactive: !row.active }"><i></i>{{ row.active ? "Активен" : "В архиве" }}</span></template>
				</SmartDataTable>
			</div>
		</div>

		<AppModal v-if="groupEditorOpen" :title="groupForm.name ? 'Группа каталога' : 'Новая группа'" @close="groupEditorOpen = false">
			<form class="editor-form" @submit.prevent="saveGroup">
				<div class="form-section">
					<div class="form-grid">
						<label class="span-2">Название<input v-model="groupForm.group_name" required autofocus /></label>
						<label>Родительская группа
							<select v-model="groupForm.parent_catalog_group">
								<option value="">Верхний уровень</option>
								<option v-for="group in groups.filter((row) => row.name !== groupForm.name)" :key="group.name" :value="group.name">{{ group.group_name }}</option>
							</select>
						</label>
					</div>
				</div>
				<p v-if="groupError" class="form-error">{{ groupError }}</p>
			</form>
			<template #footer>
				<button v-if="groupForm.name && canEdit" class="button button-secondary" :disabled="groupSaving" @click="changeGroupArchiveState">{{ groupForm.active ? "В архив" : "Восстановить" }}</button>
				<div class="footer-actions">
					<button class="button button-secondary" @click="groupEditorOpen = false">Отмена</button>
					<button class="button button-primary" :disabled="groupSaving" @click="saveGroup">{{ groupSaving ? "Сохраняем…" : "Сохранить группу" }}</button>
				</div>
			</template>
		</AppModal>

		<AppModal v-if="editorOpen" :title="itemForm.item_name || 'Новая позиция'" wide @close="editorOpen = false">
			<form class="editor-form catalog-editor" @submit.prevent="saveItem">
				<div class="form-section">
					<div class="section-heading">
						<div><h3>Основное</h3><p>Только данные, необходимые в ежедневной работе.</p></div>
					</div>
					<div class="form-grid">
						<label>Тип
							<select v-model="itemForm.item_type">
								<option v-for="(label, value) in typeLabels" :key="value" :value="value">{{ label }}</option>
							</select>
						</label>
						<label class="span-2">Наименование<input v-model="itemForm.item_name" required /></label>
						<label>Группа
							<select v-model="itemForm.catalog_group">
								<option value="">Без группы</option>
								<option v-for="group in groupOptions" :key="group.name" :value="group.name">{{ group.label }}</option>
							</select>
						</label>
						<label>Единица измерения
							<select v-model="itemForm.stock_uom" required>
								<option v-for="unit in itemOptions.units" :key="unit.name" :value="unit.name">{{ unit.unit_name }}</option>
							</select>
						</label>
						<label>Основной поставщик
							<select v-model="itemForm.default_supplier">
								<option value="">Не выбран</option>
								<option v-for="supplier in itemOptions.suppliers" :key="supplier.name" :value="supplier.name">{{ supplier.supplier_name }}</option>
							</select>
						</label>
						<label v-if="itemForm.item_type === 'Variant'" class="span-2">Основной товар
							<select v-model="itemForm.variant_of" required @change="selectVariantParent">
								<option value="">Выберите товар</option>
								<option v-for="parent in itemOptions.variant_parents" :key="parent.name" :value="parent.name">{{ parent.item_name }}</option>
							</select>
						</label>
					</div>
				</div>

				<div v-if="itemForm.item_type === 'Variant'" class="form-section">
					<div class="section-heading">
						<div><h3>Параметры модификации</h3><p>Например: цвет — белый, размер — M.</p></div>
						<button v-if="canEdit" class="text-button" type="button" @click="addVariantValue">＋ Параметр</button>
					</div>
					<div class="editable-rows">
						<div v-for="(row, index) in itemForm.variant_values" :key="index">
							<input v-model="row.attribute_name" placeholder="Параметр" />
							<input v-model="row.attribute_value" placeholder="Значение" />
							<span></span>
							<button type="button" @click="removeRow('variant_values', index)">×</button>
						</div>
					</div>
				</div>

				<div v-if="itemForm.item_type === 'Product' && itemForm.name" class="form-section">
					<div class="section-heading">
						<div><h3>Модификации</h3><p>Варианты имеют собственные остатки и могут переопределять цену.</p></div>
						<button v-if="canEdit" class="text-button" type="button" @click="createVariantFrom(itemForm.name)">＋ Модификация</button>
					</div>
					<div v-if="currentVariants.length" class="variant-list">
						<button v-for="variant in currentVariants" :key="variant.name" type="button" @click="loadEditor(variant.name)">
							<span>{{ variant.item_name }}</span><small>{{ variant.stock_uom }}</small>
						</button>
					</div>
					<p v-else class="muted-copy">Модификаций пока нет.</p>
				</div>

				<div class="form-section">
					<div class="section-heading">
						<div><h3>Цены</h3><p>Цена точки имеет приоритет над общей ценой сети.</p></div>
						<button v-if="canEdit" class="text-button" type="button" @click="addPrice">＋ Добавить цену</button>
					</div>
					<label class="check-field compact-check"><input v-model="itemForm.prevent_discounts" type="checkbox" :true-value="1" :false-value="0" /> Запретить скидки для позиции</label>
					<div class="editable-rows price-rows">
						<div v-for="(row, index) in itemForm.prices" :key="index">
							<select v-model="row.price_type"><option v-for="priceType in itemOptions.price_types" :key="priceType.name" :value="priceType.name">{{ priceType.price_type_name }}</option></select>
							<select v-model="row.business_point"><option value="">Все точки</option><option v-for="point in itemOptions.points" :key="point.name" :value="point.name">{{ point.point_name }}</option></select>
							<select v-model="row.uom"><option v-for="unit in itemOptions.units" :key="unit.name" :value="unit.name">{{ unit.unit_name }}</option></select>
							<input v-model.number="row.rate" type="number" min="0" step="0.01" placeholder="Цена" />
							<input v-model.number="row.minimum_quantity" type="number" min="0.0001" step="any" placeholder="От количества" />
							<input v-model="row.valid_from" type="date" title="Действует с" />
							<input v-model="row.valid_upto" type="date" title="Действует до" />
							<button type="button" @click="removeRow('prices', index)">×</button>
						</div>
					</div>
				</div>

				<div v-if="itemForm.item_type === 'Bundle'" class="form-section">
					<div class="section-heading">
						<div><h3>Состав комплекта</h3><p>Комплект доступен, только когда доступны его компоненты.</p></div>
						<button v-if="canEdit" class="text-button" type="button" @click="addBundleComponent">＋ Компонент</button>
					</div>
					<div class="editable-rows bundle-rows">
						<div v-for="(row, index) in itemForm.bundle_components" :key="index">
							<select v-model="row.item"><option value="">Товар или услуга</option><option v-for="item in itemOptions.items" :key="item.name" :value="item.name">{{ item.item_name }}</option></select>
							<input v-model.number="row.quantity" type="number" min="0.0001" step="any" placeholder="Количество" />
							<select v-model="row.uom"><option v-for="unit in itemOptions.units" :key="unit.name" :value="unit.name">{{ unit.unit_name }}</option></select>
							<input v-model="row.notes" placeholder="Комментарий" />
							<button type="button" @click="removeRow('bundle_components', index)">×</button>
						</div>
					</div>
				</div>

				<div class="form-section">
					<div class="section-heading">
						<div>
							<h3>{{ inventoryType ? "Остатки и доступность в точках" : "Доступность в точках" }}</h3>
							<p>Отключение точки сохраняет всю историю продаж и движений.</p>
						</div>
					</div>
					<div class="point-grid">
						<article v-for="row in itemForm.assortments" :key="row.business_point" class="point-card">
							<header><strong>{{ itemOptions.points.find((point) => point.name === row.business_point)?.point_name || row.business_point }}</strong><label class="switch-line"><input v-model="row.enabled" type="checkbox" :true-value="1" :false-value="0" /> Доступен</label></header>
							<div class="point-card__fields">
								<label class="check-field"><input v-model="row.visible_in_pos" type="checkbox" :true-value="1" :false-value="0" :disabled="!row.enabled" /> Показывать в кассе</label>
								<label>Склад
									<select v-model="row.default_warehouse" :disabled="!row.enabled">
										<option value="">Не выбран</option>
										<option v-for="warehouse in itemOptions.warehouses.filter((item) => item.business_point === row.business_point)" :key="warehouse.name" :value="warehouse.name">{{ warehouse.warehouse_name }}</option>
									</select>
								</label>
								<label v-if="inventoryType">Минимальный остаток<input v-model.number="row.minimum_stock" type="number" min="0" step="any" /></label>
								<label v-if="inventoryType">Пополнить на<input v-model.number="row.reorder_quantity" type="number" min="0" step="any" /></label>
								<label class="point-note">Заметка<input v-model="row.notes" placeholder="Необязательно" /></label>
							</div>
						</article>
					</div>
					<p v-if="!itemForm.assortments?.length" class="muted-copy">Нет доступных активных точек продаж.</p>
				</div>

				<div class="form-section system-rules">
					<div><h3>Налоги и касса</h3><p>Применяются автоматически: без НДС, система налогообложения точки, предмет расчёта — {{ itemForm.item_type === "Service" ? "услуга" : "товар" }}.</p></div>
				</div>
				<p v-if="editorError" class="form-error">{{ editorError }}</p>
			</form>
			<template #footer>
				<button v-if="itemForm.name && canEdit" class="button button-secondary" :disabled="saving" @click="changeItemArchiveState">{{ itemForm.active ? "В архив" : "Восстановить" }}</button>
				<div class="footer-actions">
					<button class="button button-secondary" @click="editorOpen = false">Закрыть</button>
					<button v-if="canEdit && itemForm.active !== 0" class="button button-primary" :disabled="saving" @click="saveItem">{{ saving ? "Сохраняем…" : "Сохранить" }}</button>
				</div>
			</template>
		</AppModal>
	</section>
</template>

<style scoped>
.catalog-workspace { display: flex; align-items: flex-start; gap: 16px; min-width: 0; }
.catalog-main { flex: 1; min-width: 0; display: grid; gap: 12px; }
.catalog-editor { display: grid; gap: 14px; }
.section-heading > div > p, .muted-copy, .system-rules p { margin: 4px 0 0; color: var(--muted); }
.compact-check { margin: 10px 0 12px; }
.price-rows > div { grid-template-columns: 1.2fr 1.2fr .7fr .8fr .8fr 1fr 1fr 34px; }
.bundle-rows > div { grid-template-columns: 2fr .65fr .8fr 1.4fr 34px; }
.point-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 10px; }
.point-card { border: 1px solid var(--border); border-radius: 12px; padding: 13px; background: #fff; }
.point-card header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.switch-line { display: flex; align-items: center; gap: 7px; font-size: 13px; }
.point-card__fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.point-card__fields label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); }
.point-card__fields .check-field { display: flex; align-items: center; color: var(--text); }
.point-note { grid-column: 1 / -1; }
.variant-list { display: grid; gap: 7px; }
.variant-list button { display: flex; justify-content: space-between; width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 9px; background: #fff; text-align: left; cursor: pointer; }
.variant-list button:hover { border-color: var(--green); background: var(--green-soft); }
.variant-list small { color: var(--muted); }
.system-rules { background: #f7f8f5; }
@media (max-width: 1100px) { .price-rows > div { grid-template-columns: 1fr 1fr 1fr 34px; } }
@media (max-width: 900px) { .catalog-workspace { flex-direction: column; } .point-card__fields { grid-template-columns: 1fr; } .point-note { grid-column: auto; } }
</style>

