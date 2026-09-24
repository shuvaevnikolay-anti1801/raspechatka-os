(function (root, factory) {
	"use strict";
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	if (root) root.RaspechatkaPassword = api;
	if (typeof document !== "undefined") {
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", () => api.init(document, root));
		} else api.init(document, root);
	}
})(typeof window !== "undefined" ? window : globalThis, function () {
	"use strict";
	const fallback = "/raspechatka";

	function resetKey(search) {
		return new URLSearchParams(search || "").get("key") || "";
	}

	function validate(oldPassword, newPassword, confirmation, hasKey) {
		if (!hasKey && !oldPassword) return { field: "old", message: "Введите текущий пароль" };
		if (!newPassword) return { field: "new", message: "Введите новый пароль" };
		if (newPassword.length < 8) return { field: "new", message: "Пароль должен содержать не менее 8 символов" };
		if (!hasKey && oldPassword === newPassword) return { field: "new", message: "Новый пароль должен отличаться от текущего" };
		if (newPassword !== confirmation) return { field: "confirm", message: "Пароли не совпадают" };
		return null;
	}

	function safeRedirect(value) {
		if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") ||
			/[\\\r\n\t\x00-\x1f]/.test(value)) return fallback;
		return value;
	}

	function publicError(status, payload, hasKey) {
		if (status === 429) return "Слишком много попыток. Попробуйте позже.";
		if (status === 410) return "Ссылка недействительна или уже использована. Попросите руководителя создать новую ссылку.";
		// Only classify known exception identifiers. Never display server details.
		const kind = String(payload?.exc_type || "");
		const serverText = String(payload?.message || "");
		if (hasKey && (kind === "InvalidResetKey" || kind === "InvalidResetKeyError" ||
			kind === "ExpiredResetKey" || kind === "ExpiredResetKeyError" ||
			kind === "ValidationError" && status === 404 ||
			/invalid (?:reset )?key|expired (?:reset )?key|invalid link|already used/i.test(serverText))) {
			return "Ссылка недействительна или уже использована. Попросите руководителя создать новую ссылку.";
		}
		if (status === 401 && !hasKey) return "Текущий пароль указан неверно";
		if (kind === "ValidationError" ||
			["PasswordPolicyError", "PasswordValidationError", "PasswordStrengthError"].includes(kind) ||
			/password (?:strength|policy)|weak password|minimum password/i.test(serverText)) {
			return "Пароль не соответствует требованиям безопасности. Сделайте его сложнее.";
		}
		return "Не удалось сохранить пароль. Попробуйте ещё раз.";
	}

	function init(doc, browserWindow) {
		const form = doc.getElementById("os-password-form");
		if (!form || form.dataset.passwordReady === "true") return null;
		form.dataset.passwordReady = "true";
		const key = resetKey(browserWindow.location.search);
		const hasKey = Boolean(key);
		const old = doc.getElementById("old-password");
		const next = doc.getElementById("new-password");
		const confirm = doc.getElementById("confirm-password");
		const submit = doc.getElementById("password-submit");
		const error = doc.getElementById("password-error");
		let submitting = false;
		if (!hasKey) {
			doc.getElementById("old-password-field").hidden = false;
			doc.getElementById("password-title").textContent = "Изменение пароля";
			doc.getElementById("password-subtitle").textContent = "Введите текущий пароль и придумайте новый";
			submit.textContent = "Изменить пароль";
		}
		(hasKey ? next : old).focus();
		for (const input of [old, next, confirm]) {
			input.addEventListener("input", () => {
				doc.getElementById(input === old ? "old-error" : input === next ? "new-error" : "confirm-error").textContent = "";
				error.hidden = true;
			});
			const toggle = input.parentElement.querySelector("button");
			toggle.addEventListener("click", () => {
				const show = input.type === "password";
				input.type = show ? "text" : "password";
				toggle.textContent = show ? "Скрыть" : "Показать";
				toggle.setAttribute("aria-label", show ? "Скрыть пароль" : "Показать пароль");
				toggle.setAttribute("aria-pressed", String(show));
				input.focus();
			});
		}
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			if (submitting) return;
			error.hidden = true;
			for (const id of ["old-error", "new-error", "confirm-error"]) doc.getElementById(id).textContent = "";
			const invalid = validate(old.value, next.value, confirm.value, hasKey);
			if (invalid) {
				doc.getElementById(`${invalid.field}-error`).textContent = invalid.message;
				({ old, new: next, confirm })[invalid.field].focus();
				return;
			}
			submitting = true;
			submit.disabled = true;
			submit.textContent = "Сохраняем…";
			try {
				const response = await browserWindow.fetch("/api/method/frappe.core.doctype.user.user.update_password", {
					method: "POST", credentials: "same-origin",
					headers: { Accept: "application/json", "Content-Type": "application/json",
						"X-Frappe-CSRF-Token": browserWindow.frappe?.csrf_token || "" },
					body: JSON.stringify({ ...(hasKey ? { key } : { old_password: old.value }),
						new_password: next.value, logout_all_sessions: 1 }),
				});
				const payload = await response.json().catch(() => ({}));
				if (!response.ok || payload.exc_type || payload.exc) {
					error.textContent = publicError(response.status, payload, hasKey);
					error.hidden = false;
					return;
				}
				const redirect = safeRedirect(payload.message);
				doc.getElementById("password-continue").href = redirect;
				form.hidden = true;
				doc.getElementById("password-success").hidden = false;
				doc.getElementById("password-continue").focus();
			} catch (_) {
				error.textContent = publicError(0, {}, hasKey);
				error.hidden = false;
			} finally {
				submitting = false;
				submit.disabled = false;
				submit.textContent = hasKey ? "Создать пароль" : "Изменить пароль";
			}
		});
		return { form, submit };
	}
	return { resetKey, validate, safeRedirect, publicError, init };
});
