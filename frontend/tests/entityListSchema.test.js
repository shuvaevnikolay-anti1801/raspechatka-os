import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	defineEntityFields,
	deriveFilterFields,
	deriveTableColumns,
	reconcileColumnOrder,
	reconcileKeys,
	reconcileVisible,
	resolveDisplayValue,
	resolveSortValue,
	searchKeys,
} from "../src/entityListSchema.js";

const fields = defineEntityFields([
	{ key: "a", label: "A", searchable: true },
	{ key: "b", label: "B", default: false },
	{ key: "c", label: "C" },
]);

test("one descriptor produces the same filter and table field set", () => {
	assert.deepEqual(
		deriveFilterFields(fields).map(({ key }) => key),
		["a", "b", "c"]
	);
	assert.deepEqual(
		deriveTableColumns(fields).map(({ key }) => key),
		["a", "b", "c"]
	);
	assert.deepEqual(searchKeys(fields), ["a"]);
});

test("schema reconciliation removes stale keys and appends new keys canonically", () => {
	assert.deepEqual(reconcileKeys(["c", "b", "a"], ["a", "c", "d"]), ["c", "a", "d"]);
	const changed = defineEntityFields([
		{ key: "a", label: "A" },
		{ key: "c", label: "C" },
		{ key: "d", label: "D" },
	]);
	assert.deepEqual(reconcileVisible(["b", "a"], changed, "filter", ["a", "b", "c"]), ["a", "d"]);
	assert.deepEqual(reconcileVisible(["b"], changed, "table"), ["a", "c", "d"]);
});

test("fixed columns remain first while user order is restored", () => {
	const columns = [{ key: "system", fixed: "left" }, { key: "a" }, { key: "b" }, { key: "c" }];
	assert.deepEqual(reconcileColumnOrder(["c", "system", "a"], columns), [
		"system",
		"c",
		"a",
		"b",
	]);
});

test("different view keys use isolated preference namespaces", () => {
	const table = readFileSync(
		new URL("../src/components/SmartDataTable.vue", import.meta.url),
		"utf8"
	);
	assert.match(table, /`\$\{props\.viewKey\}\.table`/);
	const filter = readFileSync(
		new URL("../src/components/SmartFilterBar.vue", import.meta.url),
		"utf8"
	);
	assert.match(filter, /`\$\{props\.viewKey\}\.filters`/);
});

test("search is permanent, separate from settings, applies on Enter and resets", () => {
	const source = readFileSync(
		new URL("../src/components/SmartFilterBar.vue", import.meta.url),
		"utf8"
	);
	assert.match(source, /class="smart-filter-search"/);
	assert.match(source, /placeholder="Поиск\.\.\."/);
	assert.doesNotMatch(source, /searchDefinition\.placeholder/);
	assert.match(source, /@keyup\.enter="apply"/);
	assert.match(source, /const empty = \{\s+search: ""/);
	assert.doesNotMatch(source, /schemaFields\.value\.filter\(\(field\) => !keys/);
	for (const contract of [
		"operatorOptions",
		"filter-period-presets",
		"bookmarks",
		"createBookmark",
		"useBookmark",
	])
		assert.ok(source.includes(contract), contract);
});

test("table keeps sorting, resizing, pagination, slots and selection with drag reorder", () => {
	const source = readFileSync(
		new URL("../src/components/SmartDataTable.vue", import.meta.url),
		"utf8"
	);
	for (const contract of [
		"beginResize",
		"changeSort",
		"serverPagination",
		"cell-${column.key}",
		"selection-change",
		"columnOrder",
		"dropColumn",
		"pageSize",
		"effectiveTotals",
		"page-change",
	]) {
		assert.ok(source.includes(contract), contract);
	}
	const header = source.slice(source.indexOf("<thead>"), source.indexOf("</thead>"));
	assert.ok(
		header.indexOf('v-if="selectable" class="select-cell"') <
			header.indexOf('v-for="column in visibleColumns"')
	);
});

test("technical fields are not automatically added", () => {
	const filter = readFileSync(
		new URL("../src/components/SmartFilterBar.vue", import.meta.url),
		"utf8"
	);
	for (const key of ["owner", "creation", "modified", "modified_by", "docstatus"])
		assert.doesNotMatch(filter, new RegExp(`key:\\s*["']${key}`));
});

test("standard table values use business labels without changing raw values", () => {
	const row = {
		organization: "ORG-0001",
		organization_label: "Партнёр Иванов",
		scope_type: "Business Entity",
		confirmed: 1,
	};
	assert.equal(
		resolveDisplayValue(row, { key: "organization", displayKey: "organization_label" }),
		"Партнёр Иванов"
	);
	assert.equal(row.organization, "ORG-0001");
	assert.equal(
		resolveDisplayValue(row, {
			key: "scope_type",
			type: "select",
			options: [{ value: "Business Entity", label: "Юридическое лицо" }],
		}),
		"Юридическое лицо"
	);
	assert.equal(resolveDisplayValue(row, { key: "confirmed", type: "check" }), "Да");
	assert.equal(
		resolveDisplayValue({ confirmed: 0 }, { key: "confirmed", type: "check" }),
		"Нет"
	);
});

test("custom format wins and sorting uses displayed link and select labels", () => {
	const link = { key: "organization", displayKey: "organization_label" };
	const select = {
		key: "scope_type",
		options: [
			{ value: "Partner", label: "Партнёр" },
			{ value: "Network", label: "Вся сеть" },
		],
	};
	assert.equal(
		resolveDisplayValue({ status: "raw" }, { key: "status", format: () => "Готово" }),
		"Готово"
	);
	assert.equal(
		resolveSortValue({ organization: "ORG-9", organization_label: "Иванов" }, link),
		"Иванов"
	);
	assert.equal(resolveSortValue({ scope_type: "Network" }, select), "Вся сеть");
});
