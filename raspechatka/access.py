import frappe
from frappe import _


LEVELS = {"None": 0, "View": 1, "Edit": 2, "Admin": 3}
ACTION_LEVEL = {"read": 1, "create": 2, "write": 2, "delete": 3, "admin": 3}


def get_access_level(area_code, user=None):
	user = user or frappe.session.user
	roles = set(frappe.get_roles(user))
	if "System Manager" in roles:
		return "Admin"
	area = frappe.db.get_value("Access Area", {"area_code": area_code, "active": 1}, "name")
	if not area:
		return "None"
	levels = frappe.get_all("Role Access Rule", filters={"parent": "Raspechatka Access Settings", "role": ["in", list(roles)], "access_area": area}, pluck="access_level")
	return max(levels or ["None"], key=lambda value: LEVELS.get(value, 0))


def require_access(area_code, action="read"):
	level = get_access_level(area_code)
	if LEVELS.get(level, 0) < ACTION_LEVEL.get(action, 1):
		frappe.throw(_("Недостаточно прав для этого раздела"), frappe.PermissionError)
	return level


def get_scope(user=None):
	user = user or frappe.session.user
	roles = set(frappe.get_roles(user))
	if "System Manager" in roles or "Raspechatka Network Admin" in roles:
		return {"global": True, "business_entity": None, "points": []}
	employee = frappe.db.get_value("Employee", {"user": user, "active": 1}, ["name", "business_entity"], as_dict=True)
	if not employee:
		return {"global": False, "business_entity": None, "points": []}
	points = frappe.get_all("Employee Point Assignment", filters={"parent": employee.name}, pluck="business_point")
	return {"global": False, "business_entity": employee.business_entity, "points": points}


@frappe.whitelist()
def get_access_settings():
	require_access("settings.access", "admin")
	areas = frappe.get_all("Access Area", filters={"active": 1}, fields=["name", "area_name", "area_code", "route"], order_by="sort_order asc")
	rules = frappe.get_single("Raspechatka Access Settings").get("rules")
	return {"areas": areas, "roles": ["Raspechatka Network Admin", "Raspechatka Franchise Owner", "Raspechatka Point Manager", "Raspechatka Cashier"], "rules": [row.as_dict() for row in rules]}


@frappe.whitelist(methods=["POST"])
def save_access_settings(rules):
	require_access("settings.access", "admin")
	allowed_roles = {
		"Raspechatka Network Admin",
		"Raspechatka Franchise Owner",
		"Raspechatka Point Manager",
		"Raspechatka Cashier",
	}
	allowed_areas = set(frappe.get_all("Access Area", filters={"active": 1}, pluck="name"))
	doc = frappe.get_single("Raspechatka Access Settings")
	doc.set("rules", [])
	seen = set()
	for row in frappe.parse_json(rules) or []:
		role = row.get("role")
		area = row.get("access_area")
		level = row.get("access_level")
		if role not in allowed_roles or area not in allowed_areas or level not in LEVELS:
			frappe.throw(_("Некорректное правило доступа"))
		if (role, area) in seen:
			continue
		seen.add((role, area))
		if role == "Raspechatka Network Admin" and area == "settings.access":
			level = "Admin"
		doc.append("rules", {"role": role, "access_area": area, "access_level": level})
	doc.save(ignore_permissions=True)
	return {"saved": True}
