import frappe
from frappe import _
from frappe.utils import get_url, now_datetime

from raspechatka.access import require_access


@frappe.whitelist(methods=["POST"])
def generate_invitation(profile):
	require_access("settings.access", "admin")
	doc = frappe.get_doc("Raspechatka User Profile", profile)
	doc.ensure_system_user()
	user = frappe.get_doc("User", doc.system_user)
	try:
		path = user.reset_password(send_email=False, password_expired=True)
	except TypeError:
		path = user.reset_password(send_email=False)
	link = path if str(path).startswith(("http://", "https://")) else get_url(path)
	frappe.db.set_value(
		"Raspechatka User Profile",
		doc.name,
		{"invitation_status": "Generated", "invited_at": now_datetime()},
		update_modified=True,
	)
	message = _(
		"Вам предоставлен доступ к системе «Распечатка ОС».\n"
		"Логин: {0}\n"
		"Чтобы установить пароль, перейдите по одноразовой ссылке: {1}\n"
		"После установки пароля войдите, используя номер телефона."
	).format(doc.phone, link)
	return {"login": doc.phone, "link": link, "message": message}


@frappe.whitelist(methods=["POST"])
def disable_sessions(profile):
	require_access("settings.access", "admin")
	doc = frappe.get_doc("Raspechatka User Profile", profile)
	if not doc.system_user:
		return {"disabled": 0}
	frappe.db.delete("Sessions", {"user": doc.system_user})
	return {"disabled": 1}
