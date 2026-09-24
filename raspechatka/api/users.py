# ruff: noqa: RUF001
import frappe
from frappe import _
from frappe.utils import cint, get_url, now_datetime

from raspechatka.access import get_matrix_role_rows, get_scope, require_access
from raspechatka.access_contract import access_contract
from raspechatka.api.time import get_timezone_options
from raspechatka.security import CASHIER_ROLE
from raspechatka.time_contract import TimeContractError, get_effective_site_timezone, validate_timezone


def _require_admin():
	require_access("page.references.users", "admin")


def _linked_user_timezone(profile):
	if not profile.system_user:
		return None
	return frappe.db.get_value("User", profile.system_user, "time_zone") or None


def _validated_user_timezone(value):
	if value in (None, ""):
		return ""
	try:
		return validate_timezone(str(value))
	except TimeContractError:
		frappe.throw(_("Недопустимый IANA-часовой пояс: {0}").format(value))


def _assigned_points(profile):
	if hasattr(profile, "assigned_points"):
		return [row.business_point for row in profile.assigned_points]
	return frappe.get_all("Raspechatka User Point", filters={"parent": profile.name}, pluck="business_point")


def _profile_scope(profile):
	"""Resolve a profile to active descendants only; invalid links never broaden access."""
	scope_type = "Network" if profile.access_profile == "Raspechatka Network Admin" else profile.scope_type
	if scope_type == "Network":
		return {
			"global": True,
			"scope_type": "Network",
			"organization": None,
			"entities": set(),
			"points": set(),
		}
	organization = profile.organization
	if not organization or not frappe.db.get_value("Organization", organization, "active"):
		return None
	if scope_type == "Partner":
		entities = set(
			frappe.get_all(
				"Business Entity", filters={"organization": organization, "active": 1}, pluck="name"
			)
		)
		points = set(
			frappe.get_all(
				"Business Point",
				filters={"business_entity": ["in", list(entities) or ["__none__"]], "active": 1},
				pluck="name",
			)
		)
		return {
			"global": False,
			"scope_type": "Partner",
			"organization": organization,
			"entities": entities,
			"points": points,
		}
	if scope_type not in {"Business Entity", "Points"} or not profile.business_entity:
		return None
	entity = frappe.db.get_value(
		"Business Entity", profile.business_entity, ["organization", "active"], as_dict=True
	)
	if not entity or not entity.active or entity.organization != organization:
		return None
	all_points = set(
		frappe.get_all(
			"Business Point",
			filters={"business_entity": profile.business_entity, "active": 1},
			pluck="name",
		)
	)
	points = all_points if scope_type == "Business Entity" else set(_assigned_points(profile))
	if scope_type == "Points" and (not points or not points.issubset(all_points)):
		return None
	return {
		"global": False,
		"scope_type": scope_type,
		"organization": organization,
		"entities": {profile.business_entity},
		"points": points,
	}


def _is_within_admin_scope(profile, admin_scope=None):
	admin_scope = admin_scope or get_scope()
	if admin_scope["global"]:
		return True
	target = _profile_scope(profile)
	if not target or target["global"] or target["organization"] != admin_scope["organization"]:
		return False
	ranks = {"Points": 1, "Business Entity": 2, "Partner": 3, "Network": 4}
	if ranks.get(target["scope_type"], 0) > ranks.get(admin_scope.get("scope_type"), 0):
		return False
	return target["entities"].issubset(set(admin_scope["business_entities"])) and target["points"].issubset(
		set(admin_scope["points"])
	)


def _require_profile_in_admin_scope(profile):
	if not _is_within_admin_scope(profile):
		frappe.throw(
			_("Нельзя управлять пользователем за пределами вашей области доступа"), frappe.PermissionError
		)


def _get_manageable_profile(name):
	doc = frappe.get_doc("Raspechatka User Profile", name)
	_require_profile_in_admin_scope(doc)
	return doc


def _require_employee_in_admin_scope(employee_name):
	if not employee_name:
		return
	scope = get_scope()
	if scope["global"]:
		return
	employee = frappe.db.get_value("Employee", employee_name, ["business_entity", "active"], as_dict=True)
	points = set(
		frappe.get_all("Employee Point Assignment", filters={"parent": employee_name}, pluck="business_point")
	)
	if (
		not employee
		or not employee.active
		or employee.business_entity not in scope["business_entities"]
		or not points.issubset(set(scope["points"]))
	):
		frappe.throw(
			_("Нельзя связать сотрудника за пределами вашей области доступа"), frappe.PermissionError
		)


@frappe.whitelist()
@access_contract(auth="current_user", action="read", scope="point")
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
	rows = frappe.get_all(
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
	role_labels = {role["name"]: role["label"] for role in get_matrix_role_rows()}
	for row in rows:
		row["access_profile_label"] = role_labels.get(row.access_profile, row.access_profile)
	admin_scope = get_scope()
	if admin_scope["global"]:
		return rows
	return [
		row
		for row in rows
		if _is_within_admin_scope(frappe.get_doc("Raspechatka User Profile", row.name), admin_scope)
	]


@frappe.whitelist()
@access_contract(area="page.references.users", action="admin", scope="user")
def get_user_profile(name):
	_require_admin()
	doc = _get_manageable_profile(name)
	result = doc.as_dict(no_nulls=False)
	result["time_zone"] = _linked_user_timezone(doc)
	return result


@frappe.whitelist()
@access_contract(area="page.references.users", action="admin", scope="user")
def get_user_options():
	_require_admin()
	scope = get_scope()
	organization_filters = {"active": 1}
	entity_filters = {"active": 1}
	point_filters = {"active": 1}
	employee_filters = {"active": 1}
	if not scope["global"]:
		organization_filters["name"] = scope["organization"] or "__none__"
		entity_filters["name"] = ["in", scope["business_entities"] or ["__none__"]]
		point_filters["name"] = ["in", scope["points"] or ["__none__"]]
		employee_filters["business_entity"] = ["in", scope["business_entities"] or ["__none__"]]
	employees = frappe.get_all(
		"Employee",
		filters=employee_filters,
		fields=["name", "employee_name", "system_user_profile"],
		order_by="employee_name asc",
		limit_page_length=1000,
	)
	if not scope["global"]:
		allowed_points = set(scope["points"])
		employees = [
			employee
			for employee in employees
			if set(
				frappe.get_all(
					"Employee Point Assignment",
					filters={"parent": employee.name},
					pluck="business_point",
				)
			).issubset(allowed_points)
		]
	try:
		system_timezone = get_effective_site_timezone()
	except TimeContractError:
		system_timezone = ""
	return {
		"access_roles": [
			{"name": role["name"], "label": role["label"]}
			for role in get_matrix_role_rows()
			if role["name"] != CASHIER_ROLE
		],
		"system_timezone": system_timezone,
		"timezones": get_timezone_options(),
		"organizations": frappe.get_all(
			"Organization",
			filters=organization_filters,
			fields=["name", "organization_name"],
			order_by="organization_name asc",
			limit_page_length=500,
		),
		"entities": frappe.get_all(
			"Business Entity",
			filters=entity_filters,
			fields=["name", "short_name", "organization"],
			order_by="short_name asc",
			limit_page_length=500,
		),
		"points": frappe.get_all(
			"Business Point",
			filters=point_filters,
			fields=["name", "point_name", "business_entity"],
			order_by="point_name asc",
			limit_page_length=1000,
		),
		"employees": employees,
	}


@frappe.whitelist(methods=["POST"])
@access_contract(area="page.references.users", action="admin", scope="user")
def save_user_profile(data):
	_require_admin()
	data = frappe.parse_json(data)
	name = data.get("name")
	time_zone = _validated_user_timezone(data.get("time_zone")) if "time_zone" in data else None
	doc = _get_manageable_profile(name) if name else frappe.new_doc("Raspechatka User Profile")
	old_employee = doc.linked_employee if name else None
	requested_profile = data.get("access_profile")
	if requested_profile in ("Cashier", CASHIER_ROLE) and (not name or doc.access_profile != CASHIER_ROLE):
		frappe.throw(
			_(
				"Роль кассира не создаётся как пользователь ОС. Включите «Доступ к кассе» в карточке сотрудника"
			)
		)
	for fieldname in (
		"last_name",
		"first_name",
		"middle_name",
		"phone",
		"access_profile",
		"scope_type",
		"organization",
		"business_entity",
		"linked_employee",
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
	_require_profile_in_admin_scope(doc)
	_require_employee_in_admin_scope(doc.linked_employee)
	doc.save(ignore_permissions=True)
	if "time_zone" in data and doc.system_user:
		frappe.db.set_value(
			"User",
			doc.system_user,
			"time_zone",
			time_zone,
			update_modified=False,
		)
	_sync_employee_link(doc, old_employee)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def set_user_active(profile, active):
	_require_admin()
	doc = _get_manageable_profile(profile)
	doc.active = cint(active)
	doc.save(ignore_permissions=True)
	if not doc.active:
		_close_sessions(doc.system_user)
	return {"name": doc.name, "active": doc.active}


@frappe.whitelist(methods=["POST"])
def generate_invitation(profile):
	_require_admin()
	doc = _get_manageable_profile(profile)
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
		"Вам предоставлен доступ к системе «Распечатка ОС».\n"
		"Ссылка для входа: {0}/login\n"
		"Логин: {1}\n"
		"Чтобы установить пароль, перейдите по одноразовой ссылке: {2}\n"
		"После установки пароля используйте номер телефона как логин."
	).format(get_url(), doc.phone, link)
	return {"login": doc.phone, "link": link, "message": message}


@frappe.whitelist(methods=["POST"])
def disable_sessions(profile):
	_require_admin()
	doc = _get_manageable_profile(profile)
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
