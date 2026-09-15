import frappe
from frappe import _


def _scope(scope=None):
	if scope is not None:
		return scope
	from raspechatka.access import get_scope

	return get_scope()


def allowed_entities(scope=None):
	"""Return allowed entity names for a scoped user; None means global access."""
	scope = _scope(scope)
	if scope.get("global"):
		return None
	entities = list(scope.get("business_entities") or [])
	if not entities and scope.get("business_entity"):
		entities = [scope["business_entity"]]
	return entities


def allowed_points(scope=None):
	"""Return allowed point names for a scoped user; None means global access."""
	scope = _scope(scope)
	if scope.get("global"):
		return None
	return list(scope.get("points") or [])


def entity_filter(field="business_entity", requested=None, scope=None):
	"""Build a safe Frappe filter for an entity-owned query."""
	scope = _scope(scope)
	if scope.get("global"):
		return {field: requested} if requested else {}
	entities = allowed_entities(scope) or []
	if requested:
		if requested not in entities:
			frappe.throw(_("Юридическое лицо недоступно"), frappe.PermissionError)
		return {field: requested}
	return {field: ["in", entities or ["__none__"]]}


def point_filter(field="business_point", requested=None, scope=None):
	"""Build a safe Frappe filter for a point-owned query."""
	scope = _scope(scope)
	if scope.get("global"):
		return {field: requested} if requested else {}
	points = allowed_points(scope) or []
	if requested:
		if requested not in points:
			frappe.throw(_("Точка недоступна"), frappe.PermissionError)
		return {field: requested}
	return {field: ["in", points or ["__none__"]]}


def ensure_entity_allowed(entity, scope=None):
	if not entity or not frappe.db.get_value("Business Entity", entity, "active"):
		frappe.throw(_("Выберите активное юридическое лицо"))
	scope = _scope(scope)
	if not scope.get("global") and entity not in (allowed_entities(scope) or []):
		frappe.throw(_("Юридическое лицо недоступно"), frappe.PermissionError)
	return entity


def ensure_point_allowed(point, entity=None, scope=None):
	if not point:
		frappe.throw(_("Выберите точку продаж"))
	values = frappe.db.get_value("Business Point", point, ["business_entity", "active"], as_dict=True)
	if not values or not values.active:
		frappe.throw(_("Выберите активную точку продаж"))
	scope = _scope(scope)
	if not scope.get("global") and point not in (allowed_points(scope) or []):
		frappe.throw(_("Точка недоступна"), frappe.PermissionError)
	if entity and values.business_entity != entity:
		frappe.throw(_("Точка продаж не относится к выбранному юридическому лицу"), frappe.PermissionError)
	return point
