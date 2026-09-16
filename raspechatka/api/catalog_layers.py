"""Point-oriented working views over the existing catalog domain model."""

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, nowdate

from raspechatka.access import get_scope, require_access
from raspechatka.api.frontend import _catalog_group_branch
from raspechatka.pricing import get_default_price_type, resolve_item_price


AREA_BY_LAYER = {
	"assortment": "page.catalog.assortment",
	"prices": "page.catalog.prices",
	"minimum_stock": "page.catalog.minimum-stock",
}


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
def get_options(layer="assortment"):
	_require_layer(layer)
	scope = get_scope()
	point_filters = {"active": 1}
	if not scope["global"]:
		point_filters["name"] = ["in", scope.get("points") or ["__none__"]]
	return {
		"points": frappe.get_all(
			"Business Point", filters=point_filters,
			fields=["name", "point_name", "default_price_type"], order_by="point_name asc"
		),
		"groups": frappe.get_all(
			"Catalog Group", filters={"active": 1},
			fields=["name", "group_name", "parent_catalog_group", "is_group"],
			order_by="group_name asc", limit_page_length=2000
		),
		"price_types": frappe.get_all(
			"Catalog Price Type", filters={"active": 1, "purpose": "Selling"},
			fields=["name", "price_type_name"], order_by="price_type_name asc"
		),
	}


@frappe.whitelist()
def get_rows(layer, business_point, catalog_group=None, search=None):
	_require_layer(layer)
	point = _ensure_point(business_point)
	filters, or_filters = _item_filters(catalog_group, search, layer == "minimum_stock")
	items = frappe.get_all(
		"Catalog Item", filters=filters, or_filters=or_filters,
		fields=["name", "item_name", "item_code", "item_type", "catalog_group", "stock_uom", "variant_of"],
		order_by="item_name asc", limit_page_length=5000
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
		row.item: row for row in frappe.get_all(
			"Catalog Assortment", filters={"business_point": point},
			fields=["name", "item", "enabled", "visible_in_pos", "default_warehouse"]
		)
	}
	result = []
	for item in items:
		assortment = by_item.get(item.name)
		result.append({
			**item,
			"assortment": assortment.name if assortment else None,
			"enabled": cint(assortment.enabled) if assortment else 0,
			"visible_in_pos": cint(assortment.visible_in_pos) if assortment else 0,
			"default_warehouse": assortment.default_warehouse if assortment else None,
		})
	return result


def _price_rows(point, items):
	assortment = set(
		frappe.get_all(
			"Catalog Assortment", filters={"business_point": point, "enabled": 1}, pluck="item"
		)
	)
	price_type = get_default_price_type(point)
	rows = []
	for item in items:
		if item.name not in assortment:
			continue
		price = resolve_item_price(item.name, point, price_type=price_type, uom=item.stock_uom, required=False)
		rows.append({
			**item,
			"price_type": price_type,
			"rate": price.get("rate") if price else None,
			"currency": price.get("currency") if price else "RUB",
			"price_source": price.get("source") if price else None,
			"inherited_from": price.get("inherited_from") if price else None,
			"minimum_quantity": price.get("minimum_quantity") if price else 1,
		})
	return rows


def _minimum_rows(point, items):
	warehouses = frappe.get_all(
		"Catalog Warehouse", filters={"business_point": point, "active": 1},
		fields=["name", "warehouse_name"], order_by="warehouse_name asc"
	)
	warehouse_names = [row.name for row in warehouses]
	assortments = {
		row.item: row.default_warehouse for row in frappe.get_all(
			"Catalog Assortment", filters={"business_point": point}, fields=["item", "default_warehouse"]
		)
	}
	rules = {
		(row.parent, row.warehouse): row for row in frappe.get_all(
			"Catalog Reorder Rule", filters={"warehouse": ["in", warehouse_names or ["__none__"]]},
			fields=["name", "parent", "warehouse", "minimum_stock", "reorder_quantity"]
		)
	}
	rows = []
	for item in items:
		for warehouse in warehouses:
			rule = rules.get((item.name, warehouse.name))
			rows.append({
				**item,
				"row_key": f"{item.name}:{warehouse.name}",
				"warehouse": warehouse.name,
				"warehouse_name": warehouse.warehouse_name,
				"is_assortment_warehouse": warehouse.name == assortments.get(item.name),
				"minimum_stock": flt(rule.minimum_stock) if rule else 0,
				"reorder_quantity": flt(rule.reorder_quantity) if rule else 0,
			})
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
def set_assortment(business_point, item, enabled=0, visible_in_pos=None):
	_require_layer("assortment", "write")
	point = _ensure_point(business_point)
	if not frappe.db.exists("Catalog Item", {"name": item, "active": 1}):
		frappe.throw(_("Позиция каталога недоступна."), frappe.PermissionError)
	doc = _get_or_create_assortment(item, point)
	doc.enabled = cint(enabled)
	doc.visible_in_pos = cint(visible_in_pos if visible_in_pos is not None else doc.visible_in_pos)
	if not doc.enabled:
		doc.visible_in_pos = 0
	doc.save(ignore_permissions=True)
	return {"item": item, "enabled": doc.enabled, "visible_in_pos": doc.visible_in_pos}


@frappe.whitelist(methods=["POST"])
def bulk_set_assortment(business_point, enabled=0, catalog_group=None):
	_require_layer("assortment", "write")
	point = _ensure_point(business_point)
	filters, _ = _item_filters(catalog_group)
	items = frappe.get_all("Catalog Item", filters=filters, pluck="name", limit_page_length=0)
	for item in items:
		doc = _get_or_create_assortment(item, point)
		doc.enabled = cint(enabled)
		doc.visible_in_pos = cint(enabled)
		doc.save(ignore_permissions=True)
	return {"updated": len(items)}


@frappe.whitelist(methods=["POST"])
def save_point_price(business_point, item, rate, price_type=None, uom=None):
	_require_layer("prices", "write")
	point = _ensure_point(business_point)
	doc = frappe.get_doc("Catalog Item", item)
	if not doc.active:
		frappe.throw(_("Позиция каталога недоступна."), frappe.PermissionError)
	price_type = price_type or get_default_price_type(point)
	uom = uom or doc.stock_uom
	today = getdate(nowdate())
	row = next(
		(
			row
			for row in doc.prices
			if row.business_point == point
			and row.price_type == price_type
			and (row.uom or doc.stock_uom) == uom
			and flt(row.minimum_quantity or 1) == 1
			and (not row.valid_from or getdate(row.valid_from) <= today)
			and (not row.valid_upto or getdate(row.valid_upto) >= today)
		),
		None,
	)
	if not row:
		row = doc.append(
			"prices",
			{
				"business_point": point,
				"price_type": price_type,
				"uom": uom,
				"currency": "RUB",
				"minimum_quantity": 1,
			},
		)
	row.rate = flt(rate)
	doc.save(ignore_permissions=True)
	return {"item": item, "business_point": point, "rate": row.rate, "price_type": price_type}


@frappe.whitelist(methods=["POST"])
def save_minimum_stock(business_point, item, warehouse, minimum_stock=0, reorder_quantity=0):
	_require_layer("minimum_stock", "write")
	point = _ensure_point(business_point)
	_ensure_warehouse(point, warehouse)
	doc = frappe.get_doc("Catalog Item", item)
	if not doc.active or not doc.track_inventory or doc.item_type not in ("Product", "Variant"):
		frappe.throw(
			_("Норматив разрешён только для складского товара."), frappe.PermissionError
		)
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
