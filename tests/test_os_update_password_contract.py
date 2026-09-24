from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
	return (ROOT / path).read_text(encoding="utf-8")


def test_route_and_invitation_contract():
	assert '{"from_route": "/update-password", "to_route": "os-update-password"}' in read(
		"raspechatka/hooks.py"
	)
	for path in ("raspechatka/api/users.py", "raspechatka/api/team.py"):
		assert "_reset_password(send_email=False, password_expired=True)" in read(path)


def test_page_labels_and_no_raw_backend_messages():
	html = read("raspechatka/www/os-update-password.html")
	js = read("raspechatka/public/js/os-update-password.js")
	for label in (
		"Создание пароля",
		"Текущий пароль",
		"Новый пароль",
		"Повторите пароль",
		"Создать пароль",
		"Продолжить",
	):
		assert label in html
	for forbidden in (
		"Set Password",
		"Invalid Link",
		"Passwords do not match",
		"_server_messages",
		"traceback",
		"responseJSON.message",
	):
		assert forbidden not in html + js
	assert "frappe.core.doctype.user.user.update_password" in js
	assert "logout_all_sessions: 1" in js
