import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const page = () => source("pages/InternalOrdersPage.vue");

test("internal orders route and access registry use the warehouse contract", () => {
	const router = source("router.js");
	const registry = JSON.parse(source("access-pages.json"));
	const warehouse = registry.find(({ key }) => key === "warehouse");
	const entry = warehouse?.pages.find(({ route }) => route === "/warehouse/internal-orders");

	assert.match(router, /import InternalOrdersPage from ".\/pages\/InternalOrdersPage\.vue"/);
	assert.match(
		router,
		/path: "\/warehouse\/internal-orders", name: "warehouse-internal-orders", component: InternalOrdersPage, meta: \{ module: "warehouse" \}/
	);
	assert.deepEqual(entry, {
		area: "page.warehouse.internal_orders",
		label: "Внутренние заказы",
		route: "/warehouse/internal-orders",
		order: 45,
	});
});

test("internal orders page is a read-only standard list with the approved columns", () => {
	const contents = page();
	assert.match(contents, /<ListPageHeader title="Внутренние заказы" \/>/);
	assert.match(contents, /<SmartFilterBar/);
	assert.match(contents, /<SmartDataTable/);
	assert.match(contents, /const viewKey = "warehouse\.internal-orders"/);
	assert.match(contents, /:selectable="false"/);
	for (const label of [
		"Дата",
		"Точка",
		"Сотрудник",
		"Товар / что требуется",
		"Количество",
		"Комментарий",
		"Статус",
	])
		assert.match(contents, new RegExp(`label: "${label.replace("/", "\\/")}"`), label);
	assert.doesNotMatch(contents, /Создать|Редактировать|Изменить статус|selection-change/);
});

test("internal orders filters and pagination stay server-side and use only backend options", () => {
	const contents = page();
	assert.match(contents, /raspechatka\.api\.internal_orders\.get_internal_orders/);
	assert.match(contents, /raspechatka\.api\.internal_orders\.get_internal_order_options/);
	assert.match(contents, /search: filters\.search/);
	assert.match(contents, /status: filters\.status/);
	assert.match(contents, /business_point: filters\.business_point/);
	assert.match(contents, /start,/);
	assert.match(contents, /page_length: size/);
	assert.match(contents, /options\.points = result\.points \|\| \[\]/);
	assert.match(contents, /options\.statuses = result\.statuses \|\| \[\]/);
	assert.match(contents, /:server-pagination="true"/);
	assert.match(contents, /@page-change="load"/);
	assert.match(contents, /@page-size-change="load\(1, \$event\)"/);
});

test("internal orders list waits for both widgets and rejects stale responses", () => {
	const contents = page();
	assert.match(contents, /createListReadyGate\(\(size\) => load\(1, size\)\)/);
	assert.match(contents, /@ready="listReady\.filter"/);
	assert.match(contents, /@ready="listReady\.table"/);
	assert.match(contents, /const requestId = listRequests\.begin\(\)/);
	assert.match(contents, /listRequests\.isCurrent\(requestId\)/);
	assert.doesNotMatch(contents, /onMounted\(load\)/);
});

test("internal orders list exposes loading, error, retry and empty states through SmartDataTable", () => {
	const contents = page();
	assert.match(contents, /:loading="loading"/);
	assert.match(contents, /:error="error"/);
	assert.match(contents, /@retry="load\(currentPage\)"/);
	assert.match(contents, /empty-title="Внутренних заказов пока нет"/);
	assert.match(
		contents,
		/empty-text="Потребности точки появятся здесь после синхронизации кассы\."/
	);
});
