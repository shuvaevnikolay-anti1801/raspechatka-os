import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workspace = readFileSync(
	new URL("../src/components/CatalogPriceWorkspace.vue", import.meta.url),
	"utf8"
);

test("point pricing table exposes the canonical business columns", () => {
	for (const label of [
		"Позиция",
		"Тип / группа",
		"Закупочная цена",
		"Цена продажи",
		"Наценка",
	]) {
		assert.match(workspace, new RegExp(label));
	}
	assert.doesNotMatch(workspace, />Источник</);
	assert.doesNotMatch(workspace, /v-model(?:\.number)?="row\.cost"/);
});

test("view-only mode hides every price mutation control", () => {
	assert.match(workspace, /v-if="canEdit" class="price-tools"/);
	assert.match(workspace, /:disabled="!canEdit \|\| saving\.has\(row\.name\)"/);
	assert.match(workspace, /<th v-if="canEdit">Сохранить<\/th>/);
});

test("copy and calculator require backend preview before one bulk apply", () => {
	assert.match(workspace, /preview_copy_prices/);
	assert.match(workspace, /preview_calculated_prices/);
	assert.match(workspace, /preview_token: preview\.value\.token/);
	assert.match(workspace, /Применить новые цены/);
	assert.match(workspace, /Наценка была/);
	assert.match(workspace, /Наценка станет/);
});

test("markup traffic light uses thresholds returned with rows", () => {
	assert.match(workspace, /row\.markup_lower_threshold/);
	assert.match(workspace, /row\.markup_upper_threshold/);
	for (const state of ["danger", "warning", "success"])
		assert.match(workspace, new RegExp(state));
});
