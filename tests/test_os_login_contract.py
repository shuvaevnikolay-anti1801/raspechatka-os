from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
	return (ROOT / path).read_text(encoding="utf-8")


def test_public_login_is_russian_phone_only_and_has_no_registration_or_public_reset():
	html = read("raspechatka/www/os-login.html")
	assert "Распечатка OS" in html
	assert "Вход в систему" in html
	assert "Телефон" in html and "Пароль" in html and "Войти" in html
	assert "Забыл пароль?" in html
	assert "Обратитесь к вашему руководителю для восстановления пароля" in html
	for forbidden in ("Sign up", "Registration", "Create account", "reset_password"):
		assert forbidden not in html


def test_login_frontend_guards_double_submit_and_never_renders_raw_backend_errors():
	source = read("raspechatka/public/js/os-login.js")
	assert "if (submitting) return" in source
	assert "submit.disabled = true" in source
	assert 'form.addEventListener("submit"' in source
	assert 'toggle.addEventListener("click"' in source
	assert "Неверный номер телефона или пароль" in source
	assert "Слишком много попыток входа. Попробуйте позже" in source
	assert "payload.message" not in source.replace("payload.message?.redirect_to", "")
	assert "payload._server_messages" not in source


def test_login_uses_one_classic_asset_and_renders_a_permanent_country_prefix():
	html = read("raspechatka/www/os-login.html")
	source = read("raspechatka/public/js/os-login.js")
	assert '<span class="os-phone-prefix" aria-hidden="true">+7</span>' in html
	assert 'inputmode="numeric"' in html
	assert '<script src="/assets/raspechatka/js/os-login.js" defer></script>' in html
	assert 'type="module"' not in html
	assert "login-phone.mjs" not in html
	assert not source.lstrip().startswith("import ")


def test_backend_resolves_phone_to_system_user_and_keeps_frappe_authentication():
	source = read("raspechatka/api/auth.py")
	assert '"Raspechatka User Profile"' in source
	assert "profile.system_user" in source
	assert "login_manager.authenticate" in source
	assert "login_manager.post_login" in source
	assert "@rate_limit" in source
	assert "INVALID_CREDENTIALS" in source
	assert 'form_dict.pop("password", None)' in source
	assert "password" not in read(
		"raspechatka/raspechatka_os/doctype/raspechatka_user_profile/raspechatka_user_profile.json"
	)


def test_logout_is_post_with_csrf_and_login_route_is_custom():
	navigation = read("frontend/src/components/TopNavigation.vue")
	hooks = read("raspechatka/hooks.py")
	assert 'fetch("/api/method/logout"' in navigation
	assert 'method: "POST"' in navigation
	assert '"X-Frappe-CSRF-Token"' in navigation
	assert '{"from_route": "/login", "to_route": "os-login"}' in hooks


def test_existing_admin_invitation_flow_still_uses_frappe_one_time_reset():
	users = read("raspechatka/api/users.py")
	team = read("raspechatka/api/team.py")
	for source in (users, team):
		assert "_reset_password(send_email=False, password_expired=True)" in source
		assert '"invitation_status": "Generated"' in source
	assert "frappe.core.doctype.user.user.reset_password" not in read("raspechatka/public/js/os-login.js")
