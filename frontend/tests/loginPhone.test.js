import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = {};
const { formatPhone, normalizePhone } = await import(
	"../../raspechatka/public/js/login-phone.mjs"
);

test("Russian phone variants resolve to one canonical login", () => {
	for (const value of [
		"89991234567",
		"79991234567",
		"+79991234567",
		"+7 999 123-45-67",
		"8 (999) 123-45-67",
	]) {
		assert.equal(normalizePhone(value), "+79991234567");
	}
});

test("login phone is displayed with stable +7 mask", () => {
	assert.equal(formatPhone("89991234567"), "+7 (999) 123-45-67");
	assert.equal(formatPhone("9991234567"), "+7 (999) 123-45-67");
	assert.equal(formatPhone(""), "+7");
	assert.equal(normalizePhone("+7 (999) 12"), "");
});
