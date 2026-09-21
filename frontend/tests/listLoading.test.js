import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLatestRequestGate, createListReadyGate } from "../src/listLoading.js";

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("server list readiness waits for both filter and table preferences", async () => {
	const starts = [];
	const gate = createListReadyGate((pageSize) => starts.push(pageSize));

	gate.filter();
	assert.deepEqual(starts, []);
	gate.table(50);
	assert.deepEqual(starts, [50]);
	gate.table(100);
	gate.filter();
	assert.deepEqual(starts, [50]);

	gate.reset();
	gate.table(100);
	assert.deepEqual(starts, [50]);
	gate.filter();
	assert.deepEqual(starts, [50, 100]);
});

test("latest request gate rejects stale responses", () => {
	const gate = createLatestRequestGate();
	const first = gate.begin();
	const second = gate.begin();
	assert.equal(gate.isCurrent(first), false);
	assert.equal(gate.isCurrent(second), true);
	gate.invalidate();
	assert.equal(gate.isCurrent(second), false);
});

test("filter preference restore emits ready without an implicit apply", () => {
	const filter = source("components/SmartFilterBar.vue");
	const start = filter.indexOf("async function loadPreference()");
	const end = filter.indexOf("async function toggleField", start);
	const initialization = filter.slice(start, end);

	assert.ok(start >= 0 && end > start);
	assert.match(initialization, /emit\("ready", viewKey\)/);
	assert.doesNotMatch(initialization, /\bapply\s*\(/);
	assert.match(initialization, /await nextTick\(\)/);
});

test("populated tables stay mounted while a refresh is running", () => {
	const table = source("components/SmartDataTable.vue");
	assert.match(table, /loading && hasRows/);
	assert.match(table, /loading && !hasRows/);
	assert.match(table, /Обновляем…/);
	assert.match(table, /error && !hasRows/);
});

test("standard list consumers initialize from filter readiness", () => {
	const simpleConsumers = [
		"pages/ClientMarketingPage.vue",
		"pages/ClientsPage.vue",
		"pages/EmployeesPage.vue",
		"pages/FinanceBankPage.vue",
		"pages/FinanceCalendarPage.vue",
		"pages/FinancePaymentsPage.vue",
		"pages/FinanceReportPage.vue",
		"pages/MasterDataPage.vue",
		"pages/ReferencesPage.vue",
		"pages/SalesPage.vue",
		"pages/TeamPage.vue",
		"pages/UsersPage.vue",
	];
	for (const path of simpleConsumers) {
		assert.match(source(path), /@ready="(?:load|loadRows)"/, path);
	}

	const serverConsumers = [
		"pages/CatalogPage.vue",
		"pages/WarehouseDocumentsPage.vue",
		"pages/WarehouseMovementsPage.vue",
		"pages/WarehouseReceiptsPage.vue",
		"pages/WarehouseReportPage.vue",
	];
	for (const path of serverConsumers) {
		const page = source(path);
		assert.match(page, /@ready="(?:catalogReadyGate|listReady)\.filter"/, path);
		assert.match(page, /@ready="(?:catalogReadyGate|listReady)\.table"/, path);
		assert.doesNotMatch(page, /@ready="load\(1, \$event\)"/, path);
	}
});

test("list consumers ignore stale row responses", () => {
	for (const path of [
		"pages/ClientMarketingPage.vue",
		"pages/ClientsPage.vue",
		"pages/EmployeesPage.vue",
		"pages/FinanceBankPage.vue",
		"pages/FinanceCalendarPage.vue",
		"pages/FinancePaymentsPage.vue",
		"pages/FinanceReportPage.vue",
		"pages/MasterDataPage.vue",
		"pages/ReferencesPage.vue",
		"pages/SalesPage.vue",
		"pages/TeamPage.vue",
		"pages/UsersPage.vue",
		"pages/WarehouseDocumentsPage.vue",
		"pages/WarehouseMovementsPage.vue",
		"pages/WarehouseReceiptsPage.vue",
		"pages/WarehouseReportPage.vue",
	]) {
		const page = source(path);
		assert.match(page, /createLatestRequestGate/, path);
		assert.match(page, /listRequests\.begin\(\)/, path);
		assert.match(page, /listRequests\.isCurrent\(requestId\)/, path);
	}
});

test("legacy parallel initial row loads are removed from list consumers", () => {
	for (const path of [
		"pages/ClientMarketingPage.vue",
		"pages/ClientsPage.vue",
		"pages/FinancePaymentsPage.vue",
		"pages/MasterDataPage.vue",
		"pages/ReferencesPage.vue",
		"pages/UsersPage.vue",
		"pages/WarehouseDocumentsPage.vue",
		"pages/WarehouseReceiptsPage.vue",
		"pages/WarehouseReportPage.vue",
	]) {
		const page = source(path);
		assert.doesNotMatch(page, /onMounted\([^\n]*\bload(?:Rows)?\s*\(/, path);
		assert.doesNotMatch(page, /Promise\.all\(\[\s*load(?:Rows)?\s*\(/, path);
	}
});
