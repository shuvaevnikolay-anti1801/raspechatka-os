import assert from "node:assert/strict";
import test from "node:test";

import { pageLabel, submenuForSection } from "../src/pageRegistry.js";

test("catalog workspace titles use the same labels as the product submenu", () => {
	const expected = [
		["/catalog", "Каталог"],
		["/catalog/assortment", "Ассортимент точек"],
		["/catalog/prices", "Цены"],
		["/catalog/minimum-stock", "Нормативы запасов"],
	];
	assert.deepEqual(
		submenuForSection("catalog").map(({ route, label }) => [route, label]),
		expected
	);
	for (const [route, label] of expected) assert.equal(pageLabel(route), label);
});

test("unknown routes keep an explicit page fallback", () => {
	assert.equal(pageLabel("/not-registered", "Fallback"), "Fallback");
});


test("warehouse registry exposes the internal orders route and label", () => {
	const internalOrders = submenuForSection("warehouse").find(
		({ route }) => route === "/warehouse/internal-orders"
	);
	assert.deepEqual(internalOrders && [internalOrders.route, internalOrders.label], [
		"/warehouse/internal-orders",
		"Внутренние заказы",
	]);
	assert.equal(pageLabel("/warehouse/internal-orders"), "Внутренние заказы");
});
