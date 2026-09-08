import json
from functools import lru_cache
from pathlib import Path

import frappe
from frappe import _

LEVELS = {"None": 0, "View": 1, "Edit": 2, "Admin": 3}
ACTION_LEVEL = {"read": 1, "create": 2, "write": 2, "delete": 3, "admin": 3}

PROTECTED_ROLES = {
	"All",
	"Desk User",
	"Guest",
	"Inbox User",
	"Knowledge Base Contributor",
	"Newsletter Manager",
	"Prepared Report User",
	"Report Manager",
	"Script Manager",
	"System Manager",
	"System Settings",
	"Translator",
	"Website Manager",
	"Workspace Manager",
}
ROLE_LABELS = {
	"Raspechatka Network Admin": "Администратор сети",
	"Raspechatka Franchise Owner": "Владелец франчайзи",
	"Raspechatka Point Manager": "Управляющий точками",
	"Raspechatka Cashier": "Кассир",
}
ROLE_ORDER = tuple(ROLE_LABELS)
ACCESS_SETTINGS_AREA = "page.references.access"


@lru_cache(maxsize=1)
def get_access_sections():
	manifest = Path(frappe.get_app_path("raspechatka")).parent / "frontend" / "src" / "access-pages.json"
	sections = json.loads(manifest.read_text(encoding="utf-8"))
	_seen_areas = set()
	_seen_routes = set()
	for section in sections:
		for page in section.get("pages") or []:
			area = page.get("area")
			route = page.get("route")
			if not area or not route or area in _seen_areas or route in _seen_routes:
				raise ValueError("Некорректный реестр страниц прав доступа")
			_seen_areas.add(area)
			_seen_routes.add(route)
	return sorted(sections, key=lambda row: row.get("order", 0))


def get_access_pages():
	pages = []
	for section in get_access_sections():
		for page in sorted(section.get("pages") or [], key=lambda row: row.get("order", 0)):
			pages.append(
				{
					**page,
					"section_key": section["key"],
					"section_label": section["label"],
					"section_order": section.get("order", 0),
				}
			)
	return pages


def get_access_level(area_code, user=None):
	user = user or frappe.session.user
	roles = set(frappe.get_roles(user))
	if "System Manager" in roles:
		return "Admin"
	level = _get_rule_level(area_code, roles)
	if level is not None:
		return level
	if not area_code.startswith("page."):
		return "None"
	page = next((row for row in get_access_pages() if row["area"] == area_code), None)
	legacy_level = _get_rule_level(page.get("legacy_area"), roles) if page else None
	return legacy_level or "None"


def _get_rule_level(area_code, roles):
	if not area_code or not roles:
		return None
	area = frappe.db.get_value("Access Area", {"area_code": area_code, "active": 1}, "name")
	if not area:
		return None
	levels = frappe.get_all(
		"Role Access Rule",
		filters={
			"parent": "Raspechatka Access Settings",
			"role": ["in", list(roles)],
			"access_area": area,
		},
		pluck="access_level",
	)
	return max(levels, key=lambda value: LEVELS.get(value, 0)) if levels else None


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
				{frappe.db.get_value("Business Point", point, "business_entity") for point in points} - {None}
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
		"organization": frappe.db.get_value("Business Entity", employee.business_entity, "organization"),
		"business_entity": employee.business_entity,
		"business_entities": [employee.business_entity],
		"points": points,
	}


def get_matrix_roles():
	rows = frappe.get_all(
		"Role",
		filters={"disabled": 0},
		fields=["name", "is_custom"],
		limit_page_length=1000,
	)
	roles = [
		row.name
		for row in rows
		if (row.is_custom or row.name in ROLE_ORDER) and row.name not in PROTECTED_ROLES
	]
	return sorted(
		roles,
		key=lambda role: (
			ROLE_ORDER.index(role) if role in ROLE_ORDER else len(ROLE_ORDER),
			ROLE_LABELS.get(role, role).casefold(),
		),
	)


def synchronize_access_pages(copy_legacy_rules=True):
	pages = get_access_pages()
	for index, page in enumerate(pages, start=1):
		values = {
			"area_name": page["label"],
			"route": page["route"],
			"sort_order": index * 10,
			"active": 1,
			"system_area": 1,
		}
		if frappe.db.exists("Access Area", page["area"]):
			frappe.db.set_value("Access Area", page["area"], values, update_modified=False)
		else:
			frappe.get_doc({"doctype": "Access Area", "area_code": page["area"], **values}).insert(
				ignore_permissions=True
			)

	if copy_legacy_rules:
		_sync_missing_page_rules(pages)
	return pages


def _sync_missing_page_rules(pages):
	doc = frappe.get_single("Raspechatka Access Settings")
	existing = {(row.role, row.access_area) for row in doc.rules}
	legacy_levels = {
		(row.role, row.access_area): row.access_level
		for row in doc.rules
		if not row.access_area.startswith("page.")
	}
	changed = False
	for role in get_matrix_roles():
		for page in pages:
			key = (role, page["area"])
			if key in existing:
				continue
			level = legacy_levels.get((role, page.get("legacy_area")), "None")
			if role == "Raspechatka Network Admin":
				level = "Admin"
			doc.append(
				"rules",
				{"role": role, "access_area": page["area"], "access_level": level},
			)
			existing.add(key)
			changed = True
	if changed:
		doc.save(ignore_permissions=True)


def _require_access_settings_admin():
	if (
		max(
			(get_access_level(ACCESS_SETTINGS_AREA), get_access_level("settings.access")),
			key=lambda value: LEVELS.get(value, 0),
		)
		!= "Admin"
	):
		frappe.throw(_("Недостаточно прав для настройки доступа"), frappe.PermissionError)


@frappe.whitelist()
def get_access_settings():
	_require_access_settings_admin()
	pages = synchronize_access_pages()
	visible_areas = {page["area"] for page in pages}
	rules = frappe.get_single("Raspechatka Access Settings").get("rules")
	return {
		"areas": pages,
		"roles": [{"name": role, "label": ROLE_LABELS.get(role, role)} for role in get_matrix_roles()],
		"rules": [row.as_dict() for row in rules if row.access_area in visible_areas],
	}


@frappe.whitelist(methods=["POST"])
def save_access_settings(rules):
	_require_access_settings_admin()
	pages = synchronize_access_pages(copy_legacy_rules=False)
	allowed_roles = set(get_matrix_roles())
	allowed_areas = {page["area"] for page in pages}
	doc = frappe.get_single("Raspechatka Access Settings")
	preserved = [
		{
			"role": row.role,
			"access_area": row.access_area,
			"access_level": row.access_level,
		}
		for row in doc.rules
		if row.access_area not in allowed_areas
	]
	doc.set("rules", [])
	for row in preserved:
		doc.append("rules", row)
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
		if role == "Raspechatka Network Admin" and area == ACCESS_SETTINGS_AREA:
			level = "Admin"
		doc.append("rules", {"role": role, "access_area": area, "access_level": level})
	doc.save(ignore_permissions=True)
	return {"saved": True}
