import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const login = require("../../raspechatka/public/js/os-login.js");

const markup = `
<form id="os-login-form">
  <input id="login-phone" value="">
  <small id="phone-error"></small>
  <input id="login-password" type="password" value="">
  <button id="toggle-password" type="button" aria-label="Показать пароль" aria-pressed="false">Показать</button>
  <small id="password-error"></small>
  <div id="login-error" hidden></div>
  <button id="login-submit" type="submit">Войти</button>
</form>
<button id="forgot-password" type="button">Забыл пароль?</button>
<div id="forgot-dialog" hidden><button id="close-forgot" type="button">Понятно</button></div>`;

function setup(fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })) {
	const dom = new JSDOM(markup, { url: "https://example.test/login" });
	const redirects = [];
	const browserWindow = {
		fetch,
		frappe: { csrf_token: "test-csrf" },
		location: {
			search: dom.window.location.search,
			assign: (value) => redirects.push(value),
		},
	};
	login.init(dom.window.document, browserWindow);
	return { dom, redirects };
}

function inputPhone(dom, value) {
	const field = dom.window.document.getElementById("login-phone");
	field.value = value;
	field.setSelectionRange(value.length, value.length);
	field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	return field.value;
}

function pastePhone(dom, value) {
	const field = dom.window.document.getElementById("login-phone");
	const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", { value: { getData: () => value } });
	field.dispatchEvent(event);
	return field.value;
}

test("Russian phone variants resolve to one canonical login", () => {
	for (const value of [
		"9061234567",
		"79061234567",
		"89061234567",
		"+79061234567",
		"+7 (906) 123-45-67",
		"8 (906) 123-45-67",
	]) {
		assert.equal(login.normalizePhone(value), "+79061234567");
	}
});

test("typing and paste format the national number without duplicating 7 or 8", () => {
	for (const value of ["9061234567", "79061234567", "89061234567"]) {
		const { dom } = setup();
		assert.equal(inputPhone(dom, value), "(906) 123-45-67");
	}
	for (const value of ["+7 (906) 123-45-67", "8 (906) 123-45-67"]) {
		const { dom } = setup();
		assert.equal(pastePhone(dom, value), "(906) 123-45-67");
	}
});

test("a leading 7 or 8 typed as a country prefix never enters the national number", () => {
	for (const prefix of ["7", "8"]) {
		const { dom } = setup();
		const field = dom.window.document.getElementById("login-phone");
		const event = new dom.window.InputEvent("beforeinput", {
			bubbles: true,
			cancelable: true,
			data: prefix,
			inputType: "insertText",
		});
		field.dispatchEvent(event);
		assert.equal(event.defaultPrevented, true);
		assert.equal(field.value, "");
		assert.equal(inputPhone(dom, "9061234567"), "(906) 123-45-67");
	}
});

test("password toggle changes the real input type and preserves its value", () => {
	const { dom } = setup();
	const password = dom.window.document.getElementById("login-password");
	const toggle = dom.window.document.getElementById("toggle-password");
	password.value = "secret";
	toggle.click();
	assert.equal(password.type, "text");
	assert.equal(password.value, "secret");
	assert.equal(toggle.textContent, "Скрыть");
	assert.equal(toggle.getAttribute("aria-pressed"), "true");
	toggle.click();
	assert.equal(password.type, "password");
	assert.equal(toggle.getAttribute("aria-pressed"), "false");
});

test("submit prevents navigation, posts once and redirects after success", async () => {
	const requests = [];
	const fetch = async (...args) => {
		requests.push(args);
		return { ok: true, status: 200, json: async () => ({ message: {} }) };
	};
	const { dom, redirects } = setup(fetch);
	inputPhone(dom, "9061234567");
	dom.window.document.getElementById("login-password").value = "secret";
	const event = new dom.window.Event("submit", { bubbles: true, cancelable: true });
	dom.window.document.getElementById("os-login-form").dispatchEvent(event);
	dom.window.document
		.getElementById("os-login-form")
		.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
	assert.equal(event.defaultPrevented, true);
	assert.equal(requests.length, 1);
	assert.equal(JSON.parse(requests[0][1].body).phone, "+79061234567");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(redirects, ["/raspechatka"]);
});

test("401 keeps both fields and displays a Russian error", async () => {
	const fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
	const { dom } = setup(fetch);
	inputPhone(dom, "9061234567");
	const password = dom.window.document.getElementById("login-password");
	password.value = "wrong";
	dom.window.document
		.getElementById("os-login-form")
		.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(dom.window.document.getElementById("login-phone").value, "(906) 123-45-67");
	assert.equal(password.value, "wrong");
	assert.equal(
		dom.window.document.getElementById("login-error").textContent,
		"Неверный номер телефона или пароль"
	);
	assert.equal(dom.window.document.getElementById("login-error").hidden, false);
});
