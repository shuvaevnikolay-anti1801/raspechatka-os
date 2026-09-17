(function (root, factory) {
	"use strict";

	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) root.RaspechatkaLogin = api;
	if (typeof document !== "undefined") {
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", () => api.init(document, root));
		} else {
			api.init(document, root);
		}
	}
})(typeof window !== "undefined" ? window : globalThis, function () {
	"use strict";

	function nationalDigits(value) {
		let digits = String(value || "").replace(/\D/g, "");
		if (digits.length > 10 && (digits.startsWith("7") || digits.startsWith("8"))) {
			digits = digits.slice(1);
		}
		return digits.slice(0, 10);
	}

	function formatNationalPhone(value) {
		const digits = nationalDigits(value);
		if (!digits) return "";
		let formatted = `(${digits.slice(0, 3)}`;
		if (digits.length >= 3) formatted += ")";
		if (digits.length > 3) formatted += ` ${digits.slice(3, 6)}`;
		if (digits.length > 6) formatted += `-${digits.slice(6, 8)}`;
		if (digits.length > 8) formatted += `-${digits.slice(8, 10)}`;
		return formatted;
	}

	function normalizePhone(value) {
		const digits = nationalDigits(value);
		return digits.length === 10 ? `+7${digits}` : "";
	}

	function caretAfterDigits(formatted, count) {
		if (!count) return 0;
		let seen = 0;
		for (let index = 0; index < formatted.length; index += 1) {
			if (/\d/.test(formatted[index])) seen += 1;
			if (seen === count) return index + 1;
		}
		return formatted.length;
	}

	function formatPhoneInput(input) {
		const original = input.value;
		const originalDigits = String(original).replace(/\D/g, "");
		const cursor = input.selectionStart ?? original.length;
		let digitsBeforeCursor = String(original.slice(0, cursor)).replace(/\D/g, "").length;
		if (
			originalDigits.length > 10 &&
			(originalDigits.startsWith("7") || originalDigits.startsWith("8"))
		) {
			digitsBeforeCursor = Math.max(0, digitsBeforeCursor - 1);
		}
		input.value = formatNationalPhone(original);
		const nextCursor = caretAfterDigits(input.value, digitsBeforeCursor);
		input.setSelectionRange(nextCursor, nextCursor);
	}

	function publicMessage(response, payload) {
		if (response.status === 429) return "Слишком много попыток входа. Попробуйте позже";
		if (response.status === 401) {
			const text = JSON.stringify(payload || {});
			if (text.includes("аккаунт отключён")) {
				return "Ваш аккаунт отключён. Обратитесь к руководителю";
			}
			return "Неверный номер телефона или пароль";
		}
		return "Не удалось войти. Попробуйте ещё раз";
	}

	function safeRedirect(location, payload) {
		const requested = new URLSearchParams(location.search).get("redirect-to");
		if (requested && requested.startsWith("/raspechatka") && !requested.startsWith("//")) {
			return requested;
		}
		const backendRedirect = payload.message?.redirect_to;
		return backendRedirect && backendRedirect.startsWith("/raspechatka")
			? backendRedirect
			: "/raspechatka";
	}

	function init(doc, browserWindow) {
		const form = doc.getElementById("os-login-form");
		if (!form || form.dataset.loginReady === "true") return null;
		form.dataset.loginReady = "true";

		const phone = doc.getElementById("login-phone");
		const password = doc.getElementById("login-password");
		const submit = doc.getElementById("login-submit");
		const loginError = doc.getElementById("login-error");
		const phoneError = doc.getElementById("phone-error");
		const passwordError = doc.getElementById("password-error");
		const toggle = doc.getElementById("toggle-password");
		const forgot = doc.getElementById("forgot-password");
		const dialog = doc.getElementById("forgot-dialog");
		const closeDialog = doc.getElementById("close-forgot");
		let submitting = false;

		function clearErrors() {
			phoneError.textContent = "";
			passwordError.textContent = "";
			loginError.textContent = "";
			loginError.hidden = true;
		}

		phone.addEventListener("beforeinput", (event) => {
			if (event.inputType === "insertText" && event.data && /\D/.test(event.data)) {
				event.preventDefault();
				return;
			}
			if (
				event.inputType === "insertText" &&
				(event.data === "7" || event.data === "8") &&
				(!nationalDigits(phone.value) ||
					(phone.selectionStart === 0 && phone.selectionEnd === phone.value.length))
			) {
				event.preventDefault();
				if (phone.selectionEnd === phone.value.length) phone.value = "";
			}
		});
		phone.addEventListener("input", () => {
			formatPhoneInput(phone);
			clearErrors();
		});
		phone.addEventListener("paste", (event) => {
			event.preventDefault();
			phone.value = formatNationalPhone(event.clipboardData.getData("text"));
			phone.setSelectionRange(phone.value.length, phone.value.length);
			clearErrors();
		});
		password.addEventListener("input", clearErrors);

		toggle.addEventListener("click", () => {
			const show = password.type === "password";
			password.type = show ? "text" : "password";
			toggle.textContent = show ? "Скрыть" : "Показать";
			toggle.setAttribute("aria-label", show ? "Скрыть пароль" : "Показать пароль");
			toggle.setAttribute("aria-pressed", String(show));
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
		doc.addEventListener("keydown", (event) => {
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
				const response = await browserWindow.fetch(
					"/api/method/raspechatka.api.auth.login",
					{
						method: "POST",
						credentials: "same-origin",
						headers: {
							Accept: "application/json",
							"Content-Type": "application/json",
							"X-Frappe-CSRF-Token": browserWindow.frappe?.csrf_token || "",
						},
						body: JSON.stringify({ phone: canonicalPhone, password: password.value }),
					}
				);
				const payload = await response.json().catch(() => ({}));
				if (!response.ok || payload.exc_type) {
					const loginFailure = new Error("Login failed");
					loginFailure.response = response;
					loginFailure.payload = payload;
					throw loginFailure;
				}
				browserWindow.location.assign(safeRedirect(browserWindow.location, payload));
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

		formatPhoneInput(phone);
		return { form, phone, password, submit };
	}

	return {
		formatNationalPhone,
		init,
		nationalDigits,
		normalizePhone,
		publicMessage,
		safeRedirect,
	};
});
