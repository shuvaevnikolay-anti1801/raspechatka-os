"""Point-oriented working views over the existing catalog domain model."""

import hashlib
import json
from math import ceil

import frappe
from frappe import _
from frappe.query_builder.functions import Count
from frappe.utils import add_days, cint, flt, getdate, now_datetime, nowdate

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


def _point_warehouse(point):
	warehouses = frappe.get_all(
		"Catalog Warehouse",
		filters={"business_point": point, "active": 1},
		pluck="name",
		limit_page_length=2,
	)
	if len(warehouses) != 1:
		frappe.throw(
			_("Для точки должен быть настроен ровно один активный рабочий склад."),
			frappe.ValidationError,
		)
	return warehouses[0]


def _stock_policy():
	doc = frappe.get_single("Warehouse Policy")
	policy = {
		"analysis_days": cint(doc.analysis_days),
		"minimum_days": cint(doc.minimum_days),
		"target_days": cint(doc.target_days),
	}
	if (
		policy["analysis_days"] <= 0
		or policy["minimum_days"] <= 0
		or policy["target_days"] < policy["minimum_days"]
	):
		frappe.throw(_("Политика запасов настроена некорректно. Обратитесь к администратору."))
	return policy


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
	if layer in ("prices", "minimum_stock"):
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
	warehouse = _point_warehouse(point)
	rules = {
		row.parent: row
		for row in frappe.get_all(
			"Catalog Reorder Rule",
			filters={"warehouse": warehouse, "parent": ["in", [item.name for item in items] or ["__none__"]]},
			fields=["name", "parent", "minimum_stock", "target_stock"],
		)
	}
	rows = []
	for item in items:
		rule = rules.get(item.name)
		rows.append(
			{
				**item,
				"row_key": item.name,
				"minimum_stock": flt(rule.minimum_stock) if rule else 0,
				"target_stock": max(flt(rule.target_stock), flt(rule.minimum_stock)) if rule else 0,
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
		_initialize_stock_norms([item], points)
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
		_initialize_stock_norms(items, points)
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
def save_minimum_stock(business_point, item, minimum_stock=0, target_stock=0, warehouse=None):
	_require_layer("minimum_stock", "write")
	point = _ensure_point(business_point)
	canonical_warehouse = _point_warehouse(point)
	if warehouse and warehouse != canonical_warehouse:
		frappe.throw(_("Нельзя изменить норматив для произвольного склада."), frappe.PermissionError)
	return _save_stock_norm(point, canonical_warehouse, item, minimum_stock, target_stock)


def _save_stock_norm(point, warehouse, item, minimum_stock, target_stock):
	doc = frappe.get_doc("Catalog Item", item)
	if (
		not doc.active
		or not doc.track_inventory
		or doc.item_type not in ("Product", "Variant")
		or not frappe.db.exists("Catalog Assortment", {"business_point": point, "item": item, "enabled": 1})
	):
		frappe.throw(_("Норматив разрешён только для складского товара."), frappe.PermissionError)
	minimum = flt(minimum_stock)
	target = flt(target_stock)
	if minimum < 0 or target < minimum:
		frappe.throw(
			_("Целевой остаток должен быть не меньше минимального, значения не могут быть отрицательными.")
		)
	row = next((row for row in doc.reorder_rules if row.warehouse == warehouse), None)
	if not row:
		row = doc.append("reorder_rules", {"warehouse": warehouse})
	row.minimum_stock = minimum
	row.target_stock = target
	doc.save(ignore_permissions=True)
	return {
		"item": item,
		"warehouse": warehouse,
		"minimum_stock": row.minimum_stock,
		"target_stock": row.target_stock,
	}


def _initialize_stock_norms(items, points):
	policy = _stock_policy()
	stock_items = frappe.get_all(
		"Catalog Item",
		filters={
			"name": ["in", items or ["__none__"]],
			"active": 1,
			"track_inventory": 1,
			"item_type": ["in", ["Product", "Variant"]],
		},
		fields=["name", "starting_minimum_stock"],
		limit_page_length=0,
	)
	for point in points:
		warehouse = _point_warehouse(point)
		existing = set(
			frappe.get_all(
				"Catalog Reorder Rule",
				filters={
					"warehouse": warehouse,
					"parent": ["in", [item.name for item in stock_items] or ["__none__"]],
				},
				pluck="parent",
				limit_page_length=0,
			)
		)
		for item in stock_items:
			if item.name in existing:
				continue
			minimum = max(flt(item.starting_minimum_stock), 0)
			target = ceil(minimum * policy["target_days"] / policy["minimum_days"])
			doc = frappe.get_doc("Catalog Item", item.name)
			doc.append(
				"reorder_rules", {"warehouse": warehouse, "minimum_stock": minimum, "target_stock": target}
			)
			doc.save(ignore_permissions=True)


def _eligible_stock_items(point, catalog_group=None):
	assortment_items = frappe.get_all(
		"Catalog Assortment",
		filters={"business_point": point, "enabled": 1},
		pluck="item",
		limit_page_length=0,
	)
	filters, _ = _item_filters(catalog_group, stock_only=True)
	filters["name"] = ["in", assortment_items or ["__none__"]]
	return frappe.get_all(
		"Catalog Item",
		filters=filters,
		fields=["name", "item_name", "item_code", "catalog_group", "stock_uom"],
		order_by="item_name asc",
		limit_page_length=0,
	)


def _calculate_stock_norm(net_qty, history_days, policy):
	net = max(flt(net_qty), 0)
	if net <= 0 or history_days <= 0:
		return None, None, 0
	average = net / history_days
	return (
		ceil(average * policy["minimum_days"]),
		ceil(average * policy["target_days"]),
		average,
	)


@frappe.whitelist(methods=["POST"])
@access_contract(area="page.catalog.minimum-stock", action="write", scope="point")
def copy_stock_norms(business_point, source_point, catalog_group=None):
	_require_layer("minimum_stock", "write")
	target_point = _ensure_point(business_point)
	source_point = _ensure_point(source_point)
	if source_point == target_point:
		frappe.throw(_("Точка-источник должна отличаться от точки назначения."))
	target_warehouse = _point_warehouse(target_point)
	source_warehouse = _point_warehouse(source_point)
	items = _eligible_stock_items(target_point, catalog_group)
	source_rules = {
		row.parent: row
		for row in frappe.get_all(
			"Catalog Reorder Rule",
			filters={
				"warehouse": source_warehouse,
				"parent": ["in", [item.name for item in items] or ["__none__"]],
			},
			fields=["parent", "minimum_stock", "target_stock"],
			limit_page_length=0,
		)
	}
	copied = 0
	for item in items:
		source = source_rules.get(item.name)
		if not source:
			continue
		doc = frappe.get_doc("Catalog Item", item.name)
		row = next((rule for rule in doc.reorder_rules if rule.warehouse == target_warehouse), None)
		if not row:
			row = doc.append("reorder_rules", {"warehouse": target_warehouse})
		row.minimum_stock = max(flt(source.minimum_stock), 0)
		row.target_stock = max(flt(source.target_stock), row.minimum_stock)
		doc.save(ignore_permissions=True)
		copied += 1
	skipped = len(items) - copied
	return {
		"copied": copied,
		"skipped": skipped,
		"total": len(items),
		"reasons": {"source_rule_missing": skipped} if skipped else {},
	}


def _sales_norm_preview(point, catalog_group=None, cache_result=True):
	warehouse = _point_warehouse(point)
	policy = _stock_policy()
	items = _eligible_stock_items(point, catalog_group)
	item_names = [item.name for item in items]
	from_date = getdate(add_days(nowdate(), -policy["analysis_days"] + 1))
	sales = {}
	if item_names:
		placeholders = ", ".join(["%s"] * len(item_names))
		rows = frappe.db.sql(
			f"""select line.item,
				coalesce(sum(case when receipt.receipt_type = 'Return' then -line.quantity else line.quantity end), 0) as net_qty,
				min(date(receipt.posting_datetime)) as first_sale_date
			from `tabSales Receipt Item` line
			inner join `tabSales Receipt` receipt on receipt.name = line.parent
			where receipt.business_point = %s and receipt.status = 'Posted' and receipt.docstatus = 1
				and date(receipt.posting_datetime) >= %s and line.item in ({placeholders})
			group by line.item""",
			(point, from_date, *item_names),
			as_dict=True,
		)
		sales = {row.item: row for row in rows}
	rules = {
		row.parent: row
		for row in frappe.get_all(
			"Catalog Reorder Rule",
			filters={"warehouse": warehouse, "parent": ["in", item_names or ["__none__"]]},
			fields=["parent", "minimum_stock", "target_stock", "modified"],
			limit_page_length=0,
		)
	}
	assortment_dates = {
		row.item: getdate(row.creation)
		for row in frappe.get_all(
			"Catalog Assortment",
			filters={"business_point": point, "item": ["in", item_names or ["__none__"]]},
			fields=["item", "creation"],
			limit_page_length=0,
		)
	}
	point_created = getdate(frappe.db.get_value("Business Point", point, "creation"))
	preview_rows = []
	today = getdate(nowdate())
	for item in items:
		sale = sales.get(item.name)
		rule = rules.get(item.name)
		net_qty = flt(sale.net_qty) if sale else 0
		history_start = max(from_date, point_created, assortment_dates.get(item.name, point_created))
		history_days = max((today - history_start).days + 1, 0)
		calculated_minimum, calculated_target, average = _calculate_stock_norm(net_qty, history_days, policy)
		current_minimum = flt(rule.minimum_stock) if rule else 0
		current_target = max(flt(rule.target_stock), current_minimum) if rule else 0
		status = (
			"insufficient"
			if not calculated_minimum
			else (
				"unchanged"
				if calculated_minimum == current_minimum and calculated_target == current_target
				else "change"
			)
		)
		preview_rows.append(
			{
				**item,
				"net_sold_qty": net_qty,
				"history_days": history_days,
				"short_history": 0 < history_days < policy["analysis_days"],
				"average_daily_sales": average,
				"minimum_stock": current_minimum,
				"calculated_minimum": calculated_minimum,
				"target_stock": current_target,
				"calculated_target": calculated_target,
				"status": status,
				"rule_modified": str(rule.modified) if rule else None,
			}
		)
	payload = {"point": point, "group": catalog_group or "", "policy": policy, "rows": preview_rows}
	signature = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
	token = frappe.generate_hash(length=32)
	if cache_result:
		frappe.cache.set_value(
			f"stock-norm-preview:{frappe.session.user}:{token}",
			{"signature": signature, "point": point, "group": catalog_group or ""},
			expires_in_sec=900,
		)
	counts = {
		status: sum(row["status"] == status for row in preview_rows)
		for status in ("change", "unchanged", "insufficient")
	}
	counts["skipped"] = 0
	return {
		"rows": preview_rows,
		"policy": policy,
		"counts": counts,
		"preview_token": token,
		"signature": signature,
	}


@frappe.whitelist()
@access_contract(area="page.catalog.minimum-stock", action="read", scope="point")
def preview_stock_norms(business_point, catalog_group=None):
	_require_layer("minimum_stock")
	return _sales_norm_preview(_ensure_point(business_point), catalog_group)


@frappe.whitelist(methods=["POST"])
@access_contract(area="page.catalog.minimum-stock", action="write", scope="point")
def apply_stock_norms(business_point, preview_token, catalog_group=None):
	_require_layer("minimum_stock", "write")
	point = _ensure_point(business_point)
	key = f"stock-norm-preview:{frappe.session.user}:{preview_token}"
	stored = frappe.cache.get_value(key)
	if not stored or stored.get("point") != point or stored.get("group") != (catalog_group or ""):
		frappe.throw(_("Предпросмотр устарел. Выполните расчёт заново."))
	current = _sales_norm_preview(point, catalog_group, cache_result=False)
	if current["signature"] != stored.get("signature"):
		frappe.throw(_("Данные или политика изменились. Выполните расчёт заново."))
	applied = 0
	warehouse = _point_warehouse(point)
	for row in current["rows"]:
		if row["status"] != "change":
			continue
		_save_stock_norm(
			point,
			warehouse,
			row["name"],
			row["calculated_minimum"],
			row["calculated_target"],
		)
		applied += 1
	frappe.cache.delete_value(key)
	return {"applied": applied, "skipped": len(current["rows"]) - applied}
