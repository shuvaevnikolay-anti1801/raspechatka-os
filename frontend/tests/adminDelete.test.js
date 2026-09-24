import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, compileTemplate } from "@vue/compiler-sfc";

const component = readFileSync(new URL("../src/components/AdminDelete.vue", import.meta.url), "utf8");
const { descriptor, errors } = parse(component);

test("Admin Delete exposes a gated control and valid Vue template", () => {
	assert.deepEqual(errors, []);
	assert.match(descriptor.scriptSetup.content, /canAccess\(props\.area, "Admin"\)/);
	assert.match(descriptor.template.content, /v-if="allowed && name"/);
	assert.match(descriptor.scriptSetup.content, /get_delete_preview/);
	assert.match(descriptor.scriptSetup.content, /delete_entity/);
	assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: "AdminDelete.vue", id: "admin-delete" }).errors, []);
});

test("page access exposes deletion only at Admin level", async () => {
	globalThis.window = { raspechatkaBoot: { access: { "page.sales.shifts": "Edit" } } };
	const { canAccess, boot } = await import("../src/api.js");
	assert.equal(canAccess("page.sales.shifts", "Admin"), false);
	boot.access["page.sales.shifts"] = "Admin";
	assert.equal(canAccess("page.sales.shifts", "Admin"), true);
	assert.equal(canAccess("page.sales.receipts", "Admin"), false);
	delete globalThis.window;
});
