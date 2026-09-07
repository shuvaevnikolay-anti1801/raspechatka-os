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
	if user == "Administrator" or "System Manager" in roles or "Raspechatka Network Admin" in roles:
		return {
			"global": True,
			"organization": None,
			"business_entity": None,
			"business_entities": [],
			"points": [],
		}

	profile = frappe.db.get_value(
		"Raspechatka User Profile",
		{"system_user": user, "active": 1},
		["name", "scope_type", "organization", "business_entity"],
		as_dict=True,
	)
	if profile:
		if profile.scope_type == "Network":
			return {
				"global": True,
				"organization": None,
				"business_entity": None,
				"business_entities": [],
				"points": [],
			}
		entities = []
		points = []
		if profile.scope_type == "Partner":
			entities = frappe.get_all(
				"Business Entity",
				filters={"organization": profile.organization, "active": 1},
				pluck="name",
			)
			points = frappe.get_all(
				"Business Point",
				filters={"business_entity": ["in", entities or ["__none__"]], "active": 1},
				pluck="name",
			)
		elif profile.scope_type == "Business Entity":
			entities = [profile.business_entity] if profile.business_entity else []
			points = frappe.get_all(
				"Business Point",
				filters={
					"business_entity": ["in", entities or ["__none__"]],
					"active": 1,
				},
				pluck="name",
			)
		else:
			points = frappe.get_all(
				"Raspechatka User Point",
				filters={"parent": profile.name},
				pluck="business_point",
			)
			entities = list(
				{
					frappe.db.get_value("Business Point", point, "business_entity")
					for point in points
				}
				- {None}
			)
		return {
			"global": False,
			"organization": profile.organization,
			"business_entity": entities[0] if len(entities) == 1 else None,
			"business_entities": entities,
			"points": points,
		}

	employee = frappe.db.get_value(
		"Employee",
		{"user": user, "active": 1},
		["name", "business_entity"],
		as_dict=True,
	)
	if not employee:
		return {
			"global": False,
			"organization": None,
			"business_entity": None,
			"business_entities": [],
			"points": [],
		}
	points = frappe.get_all(
		"Employee Point Assignment",
		filters={"parent": employee.name},
		pluck="business_point",
	)
	return {
		"global": False,
		"organization": frappe.db.get_value(
			"Business Entity", employee.business_entity, "organization"
		),
		"business_entity": employee.business_entity,
		"business_entities": [employee.business_entity],
		"points": points,
	}


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
