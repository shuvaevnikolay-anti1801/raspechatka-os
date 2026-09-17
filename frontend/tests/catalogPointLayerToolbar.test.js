import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toolbar = readFileSync(
	new URL("../src/components/CatalogPointLayerToolbar.vue", import.meta.url),
	"utf8",
);
const page = readFileSync(
	new URL("../src/pages/CatalogPointLayerPage.vue", import.meta.url),
	"utf8",
);
const norms = readFileSync(
	new URL("../src/components/StockNormsWorkspace.vue", import.meta.url),
	"utf8",
);

test("all three catalog layers use one responsive point toolbar", () => {
	assert.match(page, /<CatalogPointLayerToolbar/);
	assert.match(toolbar, /catalog-toolbar__context/);
	assert.match(toolbar, /catalog-toolbar__actions/);
	assert.match(toolbar, /@media \(max-width: 620px\)/);
	assert.match(toolbar, /option v-if="allowAll" value="__all__"/);
});

test("norm controls live in the parent toolbar instead of the table workspace", () => {
	assert.match(page, /normsWorkspace\?\.previewCopy\(\)/);
	assert.match(page, /normsWorkspace\?\.openCalculator\(\)/);
	assert.match(page, /Копировать нормативы/);
	assert.match(page, /Рассчитать нормативы/);
	assert.doesNotMatch(norms, /class="norms-actions"/);
	assert.doesNotMatch(norms, /<select v-model="sourcePoint"/);
});

test("norm copy and calculation use the system modal with explicit context", () => {
	assert.match(norms, /import AppModal/);
	assert.match(norms, /title="Копирование нормативов"/);
	assert.match(norms, /title="Расчёт нормативов"/);
	assert.match(norms, /Из точки/);
	assert.match(norms, /В точку/);
	assert.match(norms, /Позиций назначения/);
	assert.match(norms, /Будет изменено/);
	assert.doesNotMatch(norms, /class="norm-modal"/);
});

test("assortment bulk actions show a system preview before applying", () => {
	assert.match(page, /title="bulkIntent\.enabled \? 'Включение ассортимента'/);
	assert.match(page, /Точки продаж/);
	assert.match(page, /Сами карточки каталога сохранятся/);
	assert.match(page, /@click="requestBulk\(1\)"/);
	assert.match(page, /@click="requestBulk\(0\)"/);
});
