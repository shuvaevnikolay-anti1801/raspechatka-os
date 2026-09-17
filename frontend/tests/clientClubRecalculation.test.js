import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/pages/ClientClubPage.vue", import.meta.url), "utf8");

test("club settings expose guarded backend recalculation through AppModal", () => {
	assert.match(source, /Пересчитать скидки/);
	assert.match(source, /run_loyalty_discount_recalculation/);
	assert.match(source, /<AppModal/);
	assert.doesNotMatch(source, /window\.confirm/);
	assert.match(source, /hasUnsavedSettings/);
	assert.match(source, /page\.clients\.club/);
});

test("recalculation result shows backend statistics", () => {
	for (const field of [
		"processed",
		"changed",
		"unchanged",
		"zero_discount",
		"nonzero_discount",
		"errors",
	]) {
		assert.match(source, new RegExp(`recalculationResult\\.${field}`));
	}
});
