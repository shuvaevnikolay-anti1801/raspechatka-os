"""Point-oriented working views over the existing catalog domain model."""

import frappe
from frappe import _
from frappe.query_builder.functions import Count
from frappe.utils import cint, flt, now_datetime

from raspechatka.access import get_scope, require_access
from raspechatka.access_contract import access_contract
from raspechatka.api.frontend import _catalog_group_branch
from raspechatka.pos_settings import get_pos_sales_settings
from raspechatka.pricing import (
	get_default_price_type,
	materialize_legacy_point_prices,
	resolve_point_prices,
	set_point_price,
)
from raspechatka.stock import get_point_average_rates

AREA_BY_LAYER = {
	"assortment": "page.catalog.assortment",
	"prices": "page.catalog.prices",
	"minimum_stock": "page.catalog.minimum-stock",
}

ALL_POINTS = "__all__"


def _require_layer(layer, action="read"):
	area = AREA_BY_LAYER.get(layer)
	if not area:
		frappe.throw(_("Неизвестный слой каталога."))
	return require_access(area, action)


def _ensure_point(point):
	scope = get_scope()
	if not point or not frappe.db.exists("Business Point", {"name": point, "active": 1}):
		frappe.throw(_("Точка продаж недоступна."), frappe.PermissionError)
	if not scope["global"] and point not in (scope.get("points") or []):
		frappe.throw(_("Точка продаж недоступна."), frappe.PermissionError)
	return point


def _allowed_active_points():
	"""Return active points inside the current data scope."""
	scope = get_scope()
	filters = {"active": 1}
	if not scope["global"]:
		filters["name"] = ["in", scope.get("points") or ["__none__"]]
	return frappe.get_all("Business Point", filters=filters, pluck="name", order_by="point_name asc")


def _selected_points(point, allow_all=False):
	if point == ALL_POINTS:
		if not allow_all:
			frappe.throw(_("Выберите конкретную точку продаж."), frappe.PermissionError)
		return _allowed_active_points()
	return [_ensure_point(point)]


def _ensure_warehouse(point, warehouse):
	if not warehouse or not frappe.db.exists(
		"Catalog Warehouse", {"name": warehouse, "business_point": point, "active": 1}
	):
		frappe.throw(_("Склад недоступен для выбранной точки."), frappe.PermissionError)
	return warehouse


def _item_filters(group=None, search=None, stock_only=False):
	filters = {"active": 1}
	if group:
		filters["catalog_group"] = ["in", _catalog_group_branch(group)]
	if stock_only:
		filters.update({"track_inventory": 1, "item_type": ["in", ["Product", "Variant"]]})
	or_filters = None
	if (search or "").strip():
		value = f"%{search.strip()}%"
		or_filters = {
			"item_name": ["like", value],
			"item_code": ["like", value],
			"article": ["like", value],
		}
	return filters, or_filters


@frappe.whitelist()
@access_contract(auth="current_user", action="read", scope="point")
def get_options(layer="assortment"):
	_require_layer(layer)
	scope = get_scope()
	point_filters = {"active": 1}
	if not scope["global"]:
		point_filters["name"] = ["in", scope.get("points") or ["__none__"]]
	return {
		"points": frappe.get_all(
			"Business Point",
			filters=point_filters,
			fields=["name", "point_name", "default_price_type"],
			order_by="point_name asc",
		),
		"groups": frappe.get_all(
			"Catalog Group",
			filters={"active": 1},
			fields=["name", "group_name", "parent_catalog_group", "is_group"],
			order_by="group_name asc",
			limit_page_length=2000,
		),
		"price_types": frappe.get_all(
			"Catalog Price Type",
			filters={"active": 1, "purpose": "Selling"},
			fields=["name", "price_type_name"],
			order_by="price_type_name asc",
		),
		"warehouses": frappe.get_all(
			"Catalog Warehouse",
			filters={
				"active": 1,
				**(
					{} if scope["global"] else {"business_point": ["in", scope.get("points") or ["__none__"]]}
				),
			},
			fields=["name", "business_point", "warehouse_name"],
			order_by="warehouse_name asc",
			limit_page_length=0,
		)
		if layer == "minimum_stock"
		else [],
	}


@frappe.whitelist()
@access_contract(auth="current_user", action="read", scope="point")
def get_rows(layer, business_point, catalog_group=None, search=None):
	_require_layer(layer)
	if layer == "assortment" and business_point == ALL_POINTS:
		points = _selected_points(business_point, allow_all=True)
		filters, or_filters = _item_filters(catalog_group, search)
		items = frappe.get_all(
			"Catalog Item",
			filters=filters,
			or_filters=or_filters,
			fields=[
				"name",
				"item_name",
				"item_code",
				"item_type",
				"catalog_group",
				"stock_uom",
				"variant_of",
			],
			order_by="item_name asc",
			limit_page_length=5000,
		)
		return _assortment_rows_all(points, items)
	point = _ensure_point(business_point)
	filters, or_filters = _item_filters(catalog_group, search, layer == "minimum_stock")
	if layer == "prices":
		assortment_items = frappe.get_all(
			"Catalog Assortment",
			filters={"business_point": point, "enabled": 1},
			pluck="item",
			limit_page_length=0,
		)
		filters["name"] = ["in", assortment_items or ["__none__"]]
	items = frappe.get_all(
		"Catalog Item",
		filters=filters,
		or_filters=or_filters,
		fields=["name", "item_name", "item_code", "item_type", "catalog_group", "stock_uom", "variant_of"],
		order_by="item_name asc",
		limit_page_length=5000,
	)
	if layer == "assortment":
		return _assortment_rows(point, items)
	if layer == "prices":
		return _price_rows(point, items)
	if layer == "minimum_stock":
		return _minimum_rows(point, items)
	frappe.throw(_("Неизвестный слой каталога."))


def _assortment_rows(point, items):
	by_item = {
		row.item: row
		for row in frappe.get_all(
			"Catalog Assortment",
			filters={"business_point": point},
			fields=["name", "item", "enabled", "default_warehouse"],
		)
	}
	result = []
	for item in items:
		assortment = by_item.get(item.name)
		result.append(
			{
				**item,
				"assortment": assortment.name if assortment else None,
				"enabled": cint(assortment.enabled) if assortment else 0,
				"default_warehouse": assortment.default_warehouse if assortment else None,
			}
		)
	return result


def _assortment_rows_all(points, items):
	point_count = len(points)
	enabled_counts = {}
	if points:
		assortment = frappe.qb.DocType("Catalog Assortment")
		rows = (
			frappe.qb.from_(assortment)
			.select(assortment.item, Count(assortment.name).as_("enabled_count"))
			.where((assortment.business_point.isin(points)) & (assortment.enabled == 1))
			.groupby(assortment.item)
		).run(as_dict=True)
		for row in rows:
			enabled_counts[row.item] = cint(row.enabled_count)
	result = []
	for item in items:
		enabled_count = enabled_counts.get(item.name, 0)
		state = (
			"all" if point_count and enabled_count == point_count else "partial" if enabled_count else "none"
		)
		result.append(
			{
				**item,
				"enabled": 1 if state == "all" else 0,
				"assortment_state": state,
				"enabled_points": enabled_count,
				"point_count": point_count,
			}
		)
	return result


@frappe.whitelist()
@access_contract(area="page.catalog.assortment", action="read", scope="point")
def get_assortment_group_states(business_point):
	"""Return computed all/partial/none states; no group policy is persisted."""
	_require_layer("assortment")
	points = _selected_points(business_point, allow_all=True)
	groups = frappe.get_all(
		"Catalog Group",
		filters={"active": 1},
		fields=["name", "parent_catalog_group"],
		limit_page_length=2000,
	)
	items = frappe.get_all(
		"Catalog Item",
		filters={"active": 1},
		fields=["name", "catalog_group"],
		limit_page_length=0,
	)
	enabled_pairs = set()
	if points:
		enabled_pairs = {
			(row.item, row.business_point)
			for row in frappe.get_all(
				"Catalog Assortment",
				filters={"business_point": ["in", points], "enabled": 1},
				fields=["item", "business_point"],
				limit_page_length=0,
			)
		}
	children = {}
	for group in groups:
		children.setdefault(group.parent_catalog_group or "", []).append(group.name)
	items_by_group = {}
	for item in items:
		items_by_group.setdefault(item.catalog_group or "", []).append(item.name)

	branch_cache = {}

	def branch_items(group, visiting=None):
		if group in branch_cache:
			return branch_cache[group]
		visiting = set(visiting or ())
		if group in visiting:
			return []
		visiting.add(group)
		result = list(items_by_group.get(group, []))
		for child in children.get(group, []):
			result.extend(branch_items(child, visiting))
		branch_cache[group] = result
		return result

	result = {}
	for group in groups:
		group_items = branch_items(group.name)
		total = len(group_items) * len(points)
		enabled_count = sum((item, point) in enabled_pairs for item in group_items for point in points)
		state = "all" if total and enabled_count == total else "partial" if enabled_count else "none"
		result[group.name] = {
			"state": state,
			"enabled": enabled_count,
			"total": total,
			"items": len(group_items),
		}
	return result


def _price_rows(point, items):
	price_type = get_default_price_type(point)
	item_names = [item.name for item in items]
	prices = resolve_point_prices(item_names, point, price_type=price_type)
	costs = get_point_average_rates(item_names, point)
	settings = get_pos_sales_settings()
	rows = []
	for item in items:
		price = prices.get(item.name)
		cost = costs.get(item.name)
		rate = price.get("rate") if price else None
		markup = ((flt(rate) - flt(cost)) / flt(cost) * 100) if cost and rate is not None else None
		rows.append(
			{
				**item,
				"price_type": price_type,
				"rate": rate,
				"saved_rate": rate,
				"currency": price.get("currency") if price else "RUB",
				"cost": cost,
				"markup_percent": markup,
				"markup_lower_threshold": settings["markup_lower_threshold"],
				"markup_upper_threshold": settings["markup_upper_threshold"],
			}
		)
	return rows


def _minimum_rows(point, items):
	warehouses = frappe.get_all(
		"Catalog Warehouse",
		filters={"business_point": point, "active": 1},
		fields=["name", "warehouse_name"],
		order_by="warehouse_name asc",
	)
	warehouse_names = [row.name for row in warehouses]
	assortments = {
		row.item: row.default_warehouse
		for row in frappe.get_all(
			"Catalog Assortment", filters={"business_point": point}, fields=["item", "default_warehouse"]
		)
	}
	rules = {
		(row.parent, row.warehouse): row
		for row in frappe.get_all(
			"Catalog Reorder Rule",
			filters={"warehouse": ["in", warehouse_names or ["__none__"]]},
			fields=["name", "parent", "warehouse", "minimum_stock", "reorder_quantity"],
		)
	}
	rows = []
	for item in items:
		for warehouse in warehouses:
			rule = rules.get((item.name, warehouse.name))
			rows.append(
				{
					**item,
					"row_key": f"{item.name}:{warehouse.name}",
					"warehouse": warehouse.name,
					"warehouse_name": warehouse.warehouse_name,
					"is_assortment_warehouse": warehouse.name == assortments.get(item.name),
					"minimum_stock": flt(rule.minimum_stock) if rule else 0,
					"reorder_quantity": flt(rule.reorder_quantity) if rule else 0,
				}
			)
	return rows


def _get_or_create_assortment(item, point):
	name = frappe.db.get_value("Catalog Assortment", {"item": item, "business_point": point}, "name")
	if name:
		return frappe.get_doc("Catalog Assortment", name)
	doc = frappe.new_doc("Catalog Assortment")
	doc.item = item
	doc.business_point = point
	doc.enabled = 0
	doc.visible_in_pos = 0
	doc.default_warehouse = frappe.db.get_value(
		"Catalog Warehouse", {"business_point": point, "active": 1}, "name", order_by="warehouse_name asc"
	)
	return doc


@frappe.whitelist(methods=["POST"])
@access_contract(area="page.catalog.assortment", action="write", scope="point")
def set_assortment(business_point, item, enabled=0):
	_require_layer("assortment", "write")
	points = _selected_points(business_point, allow_all=True)
	if not frappe.db.exists("Catalog Item", {"name": item, "active": 1}):
		frappe.throw(_("Позиция каталога недоступна."), frappe.PermissionError)
	updated = _apply_assortment([item], points, cint(enabled))
	if cint(enabled):
		materialize_legacy_point_prices([item], points)
	return {"item": item, "enabled": cint(enabled), "updated": updated, "points": len(points)}


@frappe.whitelist(methods=["POST"])
@access_contract(area="page.catalog.assortment", action="write", scope="point")
def bulk_set_assortment(business_point, enabled=0, catalog_group=None):
	_require_layer("assortment", "write")
	points = _selected_points(business_point, allow_all=True)
	filters, _ = _item_filters(catalog_group)
	items = frappe.get_all("Catalog Item", filters=filters, pluck="name", limit_page_length=0)
	updated = _apply_assortment(items, points, cint(enabled))
	if cint(enabled):
		materialize_legacy_point_prices(items, points)
	return {"updated": updated, "items": len(items), "points": len(points), "enabled": cint(enabled)}


def _apply_assortment(items, points, enabled):
	"""Materialize item/point state in one request; enabled is the sale authority.

	``visible_in_pos`` remains mirrored during its compatibility window so old
	POS clients cannot observe a different state.
	"""
	if not items or not points:
		return 0
	value = cint(enabled)
	existing_pairs = {
		(row.item, row.business_point)
		for row in frappe.get_all(
			"Catalog Assortment",
			filters={"item": ["in", items], "business_point": ["in", points]},
			fields=["item", "business_point"],
			limit_page_length=0,
		)
	}
	assortment = frappe.qb.DocType("Catalog Assortment")
	(
		frappe.qb.update(assortment)
		.set(assortment.enabled, value)
		.set(assortment.visible_in_pos, value)
		.where((assortment.item.isin(items)) & (assortment.business_point.isin(points)))
	).run()
	if not value:
		# Absence already means disabled. Do not create a large matrix of zero rows.
		return len(items) * len(points)

	warehouses = {
		point: frappe.db.get_value(
			"Catalog Warehouse",
			{"business_point": point, "active": 1},
			"name",
			order_by="warehouse_name asc",
		)
		for point in points
	}
	now = now_datetime()
	owner = frappe.session.user
	# Use Frappe's supported batched insert. Existing rows were updated above;
	# deterministic names plus ignore_duplicates make retries harmless.
	missing_pairs = [
		(item, point) for point in points for item in items if (item, point) not in existing_pairs
	]
	values = [
		(f"{point}-{item}", now, now, owner, owner, item, point, warehouses.get(point), value, value)
		for item, point in missing_pairs
	]
	if values:
		frappe.db.bulk_insert(
			"Catalog Assortment",
			fields=[
				"name",
				"creation",
				"modified",
				"owner",
				"modified_by",
				"item",
				"business_point",
				"default_warehouse",
				"enabled",
				"visible_in_pos",
			],
			values=values,
			ignore_duplicates=True,
			chunk_size=500,
		)
	return len(items) * len(points)


@frappe.whitelist(methods=["POST"])
@access_contract(area="page.catalog.prices", action="write", scope="point")
def save_point_price(business_point, item, rate, price_type=None, uom=None):
	_require_layer("prices", "write")
	point = _ensure_point(business_point)
	if not frappe.db.exists("Catalog Assortment", {"business_point": point, "item": item, "enabled": 1}):
		frappe.throw(
			_("Цена точки разрешена только для позиции её продаваемого ассортимента."),
			frappe.PermissionError,
		)
	if rate in (None, "") or flt(rate) < 0:
		frappe.throw(_("Цена продажи должна быть неотрицательным числом."))
	canonical_price_type = get_default_price_type(point)
	if price_type and price_type != canonical_price_type:
		frappe.throw(_("Для точки можно изменить только её рабочую цену продажи."), frappe.PermissionError)
	saved_rate = set_point_price(item, point, rate, canonical_price_type)
	return {
		"item": item,
		"business_point": point,
		"rate": saved_rate,
		"price_type": canonical_price_type,
	}


@frappe.whitelist(methods=["POST"])
@access_contract(area="page.catalog.minimum-stock", action="write", scope="point")
def save_minimum_stock(business_point, item, warehouse, minimum_stock=0, reorder_quantity=0):
	_require_layer("minimum_stock", "write")
	point = _ensure_point(business_point)
	_ensure_warehouse(point, warehouse)
	doc = frappe.get_doc("Catalog Item", item)
	if not doc.active or not doc.track_inventory or doc.item_type not in ("Product", "Variant"):
		frappe.throw(_("Норматив разрешён только для складского товара."), frappe.PermissionError)
	row = next((row for row in doc.reorder_rules if row.warehouse == warehouse), None)
	if not row:
		row = doc.append("reorder_rules", {"warehouse": warehouse})
	row.minimum_stock = flt(minimum_stock)
	row.reorder_quantity = flt(reorder_quantity)
	doc.save(ignore_permissions=True)
	return {
		"item": item,
		"warehouse": warehouse,
		"minimum_stock": row.minimum_stock,
		"reorder_quantity": row.reorder_quantity,
	}
