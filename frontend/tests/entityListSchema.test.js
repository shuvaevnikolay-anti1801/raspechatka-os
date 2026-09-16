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
