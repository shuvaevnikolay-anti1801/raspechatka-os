import frappe
from frappe import _
from frappe.utils import cint, get_url, now_datetime

from raspechatka.access import require_access


def _require_admin():
	require_access("settings.access", "admin")


@frappe.whitelist()
def get_users(search=None, active=None):
	_require_admin()
	filters = {}
	if active not in (None, ""):
		filters["active"] = cint(active)
	or_filters = None
	if search:
		value = f"%{search.strip()}%"
		or_filters = {
			"full_name": ["like", value],
			"phone": ["like", value],
		}
	return frappe.get_all(
		"Raspechatka User Profile",
		filters=filters,
		or_filters=or_filters,
		fields=[
			"name",
			"full_name",
			"phone",
			"access_profile",
			"scope_type",
			"organization",
			"business_entity",
			"linked_employee",
			"invitation_status",
			"active",
		],
		order_by="full_name asc",
		limit_page_length=1000,
	)


@frappe.whitelist()
def get_user_profile(name):
	_require_admin()
	return frappe.get_doc("Raspechatka User Profile", name).as_dict(no_nulls=False)


@frappe.whitelist()
def get_user_options():
	_require_admin()
	return {
		"organizations": frappe.get_all(
			"Organization",
			filters={"active": 1},
			fields=["name", "organization_name"],
			order_by="organization_name asc",
			limit_page_length=500,
		),
		"entities": frappe.get_all(
			"Business Entity",
			filters={"active": 1},
			fields=["name", "short_name", "organization"],
			order_by="short_name asc",
			limit_page_length=500,
		),
		"points": frappe.get_all(
			"Business Point",
			filters={"active": 1},
			fields=["name", "point_name", "business_entity"],
			order_by="point_name asc",
			limit_page_length=1000,
		),
		"employees": frappe.get_all(
			"Employee",
			filters={"active": 1},
			fields=["name", "employee_name", "system_user_profile"],
			order_by="employee_name asc",
			limit_page_length=1000,
		),
	}


@frappe.whitelist(methods=["POST"])
def save_user_profile(data):
	_require_admin()
	data = frappe.parse_json(data)
	name = data.get("name")
	doc = (
		frappe.get_doc("Raspechatka User Profile", name)
		if name
		else frappe.new_doc("Raspechatka User Profile")
	)
	old_employee = doc.linked_employee if name else None
	for fieldname in (
		"active",
		"last_name",
		"first_name",
		"middle_name",
		"phone",
		"access_profile",
		"scope_type",
		"organization",
		"business_entity",
		"linked_employee",
		"notes",
	):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.set("assigned_points", [])
	for row in data.get("assigned_points") or []:
		doc.append(
			"assigned_points",
			{
				"business_point": row.get("business_point"),
				"is_default": cint(row.get("is_default")),
			},
		)
	doc.save(ignore_permissions=True)
	_sync_employee_link(doc, old_employee)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def set_user_active(profile, active):
	_require_admin()
	doc = frappe.get_doc("Raspechatka User Profile", profile)
	doc.active = cint(active)
	doc.save(ignore_permissions=True)
	if not doc.active:
		_close_sessions(doc.system_user)
	return {"name": doc.name, "active": doc.active}


@frappe.whitelist(methods=["POST"])
def generate_invitation(profile):
	_require_admin()
	doc = frappe.get_doc("Raspechatka User Profile", profile)
	doc.ensure_system_user()
	user = frappe.get_doc("User", doc.system_user)
	link = user._reset_password(send_email=False, password_expired=True)
	frappe.db.set_value(
		"Raspechatka User Profile",
		doc.name,
		{"invitation_status": "Generated", "invited_at": now_datetime()},
		update_modified=True,
	)
	message = _(
		"Вам предоставлен доступ к системе «Распечатка ОС».\n"  # noqa: RUF001
		"Ссылка для входа: {0}/login\n"
		"Логин: {1}\n"
		"Чтобы установить пароль, перейдите по одноразовой ссылке: {2}\n"
		"После установки пароля используйте номер телефона как логин."
	).format(get_url(), doc.phone, link)
	return {"login": doc.phone, "link": link, "message": message}


@frappe.whitelist(methods=["POST"])
def disable_sessions(profile):
	_require_admin()
	doc = frappe.get_doc("Raspechatka User Profile", profile)
	return {"disabled": _close_sessions(doc.system_user)}


def _sync_employee_link(doc, old_employee=None):
	if old_employee and old_employee != doc.linked_employee:
		frappe.db.set_value(
			"Employee",
			old_employee,
			"system_user_profile",
			None,
			update_modified=False,
		)
	if doc.linked_employee:
		frappe.db.set_value(
			"Employee",
			doc.linked_employee,
			"system_user_profile",
			doc.name,
			update_modified=False,
		)


def _close_sessions(user):
	if not user:
		return 0
	frappe.db.delete("Sessions", {"user": user})
	return 1
