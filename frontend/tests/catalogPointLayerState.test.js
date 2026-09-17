import assert from "node:assert/strict";
import test from "node:test";

import {
	layerEmptyMessage,
	normalizeBusinessPoint,
	priceSourceLabel,
} from "../src/catalogPointLayerState.js";

const points = [{ name: "POINT-A" }, { name: "POINT-B" }];

test("prices and minimum stock always normalize all-points to a concrete allowed point", () => {
	assert.equal(normalizeBusinessPoint("prices", "__all__", points), "POINT-A");
	assert.equal(normalizeBusinessPoint("minimum_stock", "POINT-B", points), "POINT-B");
	assert.equal(normalizeBusinessPoint("prices", "POINT-X", points), "POINT-A");
	assert.equal(normalizeBusinessPoint("minimum_stock", "__all__", []), "");
});

test("assortment retains its all-points contract", () => {
	assert.equal(normalizeBusinessPoint("assortment", "__all__", points), "__all__");
	assert.equal(normalizeBusinessPoint("assortment", "POINT-B", points), "POINT-B");
	assert.equal(normalizeBusinessPoint("assortment", "POINT-X", points), "__all__");
});

test("price sources and layer empty states are user-facing", () => {
	assert.equal(priceSourceLabel("Point"), "Точка");
	assert.equal(priceSourceLabel("Network"), "Сеть");
	assert.equal(priceSourceLabel("Variant Parent"), "Основной товар");
	assert.equal(priceSourceLabel(null), "Нет цены");
	assert.match(layerEmptyMessage("prices"), /продаваемых позиций/);
	assert.match(layerEmptyMessage("minimum_stock", false), /нет активных складов/);
	assert.doesNotMatch(layerEmptyMessage("minimum_stock", true), /фильтр/);
});
