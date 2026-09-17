import { formatPhone, normalizePhone } from "/assets/raspechatka/js/login-phone.mjs";

(function () {
	"use strict";

	const form = document.getElementById("os-login-form");
	if (!form) return;

	const phone = document.getElementById("login-phone");
	const password = document.getElementById("login-password");
	const submit = document.getElementById("login-submit");
	const loginError = document.getElementById("login-error");
	const phoneError = document.getElementById("phone-error");
	const passwordError = document.getElementById("password-error");
	const toggle = document.getElementById("toggle-password");
	const forgot = document.getElementById("forgot-password");
	const dialog = document.getElementById("forgot-dialog");
	const closeDialog = document.getElementById("close-forgot");
	let submitting = false;

	function clearErrors() {
		phoneError.textContent = "";
		passwordError.textContent = "";
		loginError.textContent = "";
		loginError.hidden = true;
	}

	function publicMessage(response, payload) {
		if (response.status === 429) return "Слишком много попыток входа. Попробуйте позже";
		if (response.status === 401) {
			const text = JSON.stringify(payload || {});
			if (text.includes("аккаунт отключён"))
				return "Ваш аккаунт отключён. Обратитесь к руководителю";
			return "Неверный номер телефона или пароль";
		}
		return "Не удалось войти. Попробуйте ещё раз";
	}

	phone.addEventListener("input", () => {
		phone.value = formatPhone(phone.value);
		clearErrors();
	});
	phone.addEventListener("paste", (event) => {
		event.preventDefault();
		phone.value = formatPhone(event.clipboardData.getData("text"));
		clearErrors();
	});
	password.addEventListener("input", clearErrors);

	toggle.addEventListener("click", () => {
		const visible = password.type === "text";
		password.type = visible ? "password" : "text";
		toggle.textContent = visible ? "Показать" : "Скрыть";
		toggle.setAttribute("aria-label", visible ? "Показать пароль" : "Скрыть пароль");
		toggle.setAttribute("aria-pressed", String(!visible));
		password.focus();
	});

	forgot.addEventListener("click", () => {
		dialog.hidden = false;
		closeDialog.focus();
	});
	closeDialog.addEventListener("click", () => {
		dialog.hidden = true;
		forgot.focus();
	});
	dialog.addEventListener("click", (event) => {
		if (event.target === dialog) closeDialog.click();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !dialog.hidden) closeDialog.click();
	});

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (submitting) return;
		clearErrors();
		const canonicalPhone = normalizePhone(phone.value);
		if (!phone.value.trim()) {
			phoneError.textContent = "Введите номер телефона";
			phone.focus();
			return;
		}
		if (!canonicalPhone) {
			phoneError.textContent = "Введите корректный номер телефона";
			phone.focus();
			return;
		}
		if (!password.value) {
			passwordError.textContent = "Введите пароль";
			password.focus();
			return;
		}

		submitting = true;
		submit.disabled = true;
		submit.textContent = "Входим…";
		try {
			const response = await fetch("/api/method/raspechatka.api.auth.login", {
				method: "POST",
				credentials: "same-origin",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					"X-Frappe-CSRF-Token": window.frappe?.csrf_token || "",
				},
				body: JSON.stringify({ phone: canonicalPhone, password: password.value }),
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok || payload.exc_type) throw { response, payload };
			const requested = new URLSearchParams(window.location.search).get("redirect-to");
			const safeRedirect =
				requested && requested.startsWith("/raspechatka") && !requested.startsWith("//")
					? requested
					: payload.message?.redirect_to || "/raspechatka";
			window.location.assign(safeRedirect);
		} catch (error) {
			loginError.textContent = publicMessage(error.response || {}, error.payload || {});
			loginError.hidden = false;
			password.select();
		} finally {
			submitting = false;
			submit.disabled = false;
			submit.textContent = "Войти";
		}
	});

	phone.value = formatPhone(phone.value);
})();
