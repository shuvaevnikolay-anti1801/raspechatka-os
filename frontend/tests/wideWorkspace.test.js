import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function block(selector) {
	const start = styles.indexOf(selector);
	assert.ok(start >= 0, `missing CSS block: ${selector}`);
	const open = styles.indexOf("{", start);
	const close = styles.indexOf("}", open);
	assert.ok(open >= 0 && close > open, `invalid CSS block: ${selector}`);
	return styles.slice(open + 1, close);
}

test("main Web OS page has no global desktop width ceiling", () => {
	const page = block(".page {");
	assert.match(page, /width:\s*100%/);
	assert.match(page, /min-width:\s*0/);
	assert.doesNotMatch(page, /max-width\s*:/);
	assert.doesNotMatch(page, /margin:\s*0\s+auto/);
});

test("wide-screen page gutter is bounded while mobile padding stays compact", () => {
	const page = block(".page {");
	assert.match(page, /padding:\s*34px\s+clamp\(24px,\s*2\.2vw,\s*48px\)\s+56px/);

	assert.match(
		styles,
		/@media\s*\(max-width:\s*760px\)[\s\S]*?\.page\s*\{[\s\S]*?padding:\s*24px\s+14px\s+40px/
	);
});

test("shared filters and tables can fill the fluid workspace", () => {
	assert.match(
		styles,
		/\.smart-filter,\s*\n\.smart-table\s*\{\s*width:\s*100%;\s*min-width:\s*0;\s*\}/
	);
	assert.match(styles, /\.table-shell\s*\{[\s\S]*?overflow-x:\s*auto/);
	assert.match(styles, /\.smart-table table\s*\{[\s\S]*?min-width:\s*760px/);
});

test("intentional local readable-width limits remain intact", () => {
	assert.match(styles, /\.placeholder-card\s*\{[\s\S]*?max-width:\s*720px/);
	assert.match(styles, /\.assistant-welcome\s*\{[\s\S]*?max-width:\s*620px/);
});
