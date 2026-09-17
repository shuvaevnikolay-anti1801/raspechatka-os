from datetime import datetime, time

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, nowdate

from raspechatka.access import get_scope, require_access, require_any_access
from raspechatka.api.warehouse import _ensure_point
from raspechatka.stock import effective_ledger_condition, get_active_import_batch


@frappe.whitelist()
def get_stock_balances(
	as_of=None,
	business_point=None,
	warehouse=None,
	catalog_group=None,
	search=None,
	show_zero=0,
	limit_start=0,
	limit_page_length=25,
):
	require_access("page.warehouse.balances", "read")
	as_of = as_of or nowdate()
	end = datetime.combine(getdate(as_of), time.max)
	warehouses = _warehouses(business_point, warehouse)
	if getdate(as_of) >= getdate(nowdate()):
		aggregated = _current_balances(warehouses)
	else:
		aggregated = _historical_balances(warehouses, end)
	expected = _expected_quantities(warehouses)
	minimums = _minimum_stock_levels(warehouses)
	for key in set(expected) | set(minimums):
		aggregated.setdefault(
			key,
			{
				"quantity": 0,
				"reserved_quantity": 0,
				"stock_value": 0,
				"last_movement_at": None,
				"locations": set(),
			},
		)
	if int(show_zero):
		stock_items = frappe.get_all(
			"Catalog Item",
			filters={"active": 1, "track_inventory": 1, "item_type": ["in", ["Product", "Variant"]]},
			pluck="name",
			limit_page_length=0,
		)
		for item in stock_items:
			for warehouse_name in warehouses:
				aggregated.setdefault(
					(item, warehouse_name),
					{
						"quantity": 0,
						"reserved_quantity": 0,
						"stock_value": 0,
						"last_movement_at": None,
						"locations": set(),
					},
				)
	metadata = _item_metadata({key[0] for key in aggregated})
	warehouse_map = {
		row.name: row
		for row in frappe.get_all(
			"Catalog Warehouse",
			filters={"name": ["in", warehouses or ["__none__"]]},
			fields=["name", "warehouse_name", "business_point"],
		)
	}
	location_names = {
		row.name: row.full_address
		for row in frappe.get_all("Storage Location", fields=["name", "full_address"], limit_page_length=0)
	}
	rows = []
	query = (search or "").strip().lower()
	for (item, warehouse_name), values in aggregated.items():
		meta = metadata.get(item)
		if not meta or (catalog_group and meta.catalog_group != catalog_group):
			continue
		if (
			query
			and query
			not in " ".join((meta.item_name or "", meta.item_code or "", meta.article or "")).lower()
		):
			continue
		qty = flt(values["quantity"])
		reserved = flt(values.get("reserved_quantity"))
		available = qty - reserved
		expected_qty = flt(expected.get((item, warehouse_name)))
		minimum_stock = flt(minimums.get((item, warehouse_name)))
		recommended = max(minimum_stock - available - expected_qty, 0)
		if not int(show_zero) and abs(qty) < 0.000001 and not expected_qty and not recommended:
			continue
		value = flt(values["stock_value"])
		wh = warehouse_map.get(warehouse_name)
		rows.append(
			{
				"item": item,
				"item_code": meta.item_code,
				"item_name": meta.item_name,
				"article": meta.article,
				"catalog_group": meta.catalog_group,
				"uom": meta.stock_uom,
				"business_point": wh.business_point if wh else None,
				"warehouse": warehouse_name,
				"warehouse_name": wh.warehouse_name if wh else warehouse_name,
				"storage_location": ", ".join(
					sorted(location_names.get(name, name) for name in values["locations"])
				)
				or None,
				"quantity": qty,
				"reserved_quantity": reserved,
				"available_quantity": available,
				"expected_quantity": expected_qty,
				"minimum_stock": minimum_stock,
				"recommended_order_quantity": recommended,
				"average_rate": flt(value / qty) if qty else 0,
				"stock_value": value,
				"last_movement_at": values.get("last_movement_at"),
			}
		)
	rows.sort(
		key=lambda row: (
			row["catalog_group"] or "",
			row["item_name"],
			row["warehouse_name"],
			row["storage_location"] or "",
		)
	)
	return {
		"rows": _paginate_rows(rows, limit_start, limit_page_length),
		"total": len(rows),
		"totals": {
			"quantity": sum(row["quantity"] for row in rows),
			"reserved_quantity": sum(row["reserved_quantity"] for row in rows),
			"available_quantity": sum(row["available_quantity"] for row in rows),
			"expected_quantity": sum(row["expected_quantity"] for row in rows),
			"recommended_order_quantity": sum(row["recommended_order_quantity"] for row in rows),
			"stock_value": sum(row["stock_value"] for row in rows),
		},
		"as_of": str(as_of),
	}


@frappe.whitelist()
def get_stock_turnover(
	from_date=None,
	to_date=None,
	business_point=None,
	warehouse=None,
	catalog_group=None,
	search=None,
	limit_start=0,
	limit_page_length=25,
):
	require_access("page.warehouse.turnover", "read")
	from_date, to_date = from_date or nowdate(), to_date or nowdate()
	if getdate(from_date) > getdate(to_date):
		frappe.throw(_("Дата начала не может быть позже даты окончания."))
	start = datetime.combine(getdate(from_date), time.min)
	end = datetime.combine(getdate(to_date), time.max)
	warehouses = _warehouses(business_point, warehouse)
	aggregated = _turnover_totals(warehouses, start, end)
	metadata = _item_metadata({key[0] for key in aggregated})
	warehouse_map = {
		row.name: row
		for row in frappe.get_all(
			"Catalog Warehouse",
			filters={"name": ["in", warehouses or ["__none__"]]},
			fields=["name", "warehouse_name", "business_point"],
		)
	}
	query = (search or "").strip().lower()
	rows = []
	for (item, warehouse_name), values in aggregated.items():
		meta = metadata.get(item)
		if not meta or (catalog_group and meta.catalog_group != catalog_group):
			continue
		if (
			query
			and query
			not in " ".join((meta.item_name or "", meta.item_code or "", meta.article or "")).lower()
		):
			continue
		closing_qty = values["opening_qty"] + values["incoming_qty"] - values["outgoing_qty"]
		closing_value = values["opening_value"] + values["incoming_value"] - values["outgoing_value"]
		wh = warehouse_map.get(warehouse_name)
		rows.append(
			{
				"item": item,
				"item_code": meta.item_code,
				"item_name": meta.item_name,
				"catalog_group": meta.catalog_group,
				"uom": meta.stock_uom,
				"business_point": wh.business_point if wh else None,
				"warehouse": warehouse_name,
				"warehouse_name": wh.warehouse_name if wh else warehouse_name,
				**values,
				"closing_qty": closing_qty,
				"closing_value": closing_value,
			}
		)
	rows.sort(key=lambda row: (row["catalog_group"] or "", row["item_name"], row["warehouse_name"]))
	keys = (
		"opening_qty",
		"opening_value",
		"incoming_qty",
		"incoming_value",
		"outgoing_qty",
		"outgoing_value",
		"closing_qty",
		"closing_value",
	)
	return {
		"rows": _paginate_rows(rows, limit_start, limit_page_length),
		"total": len(rows),
		"totals": {key: sum(row[key] for row in rows) for key in keys},
		"from_date": str(from_date),
		"to_date": str(to_date),
	}


@frappe.whitelist()
def get_stock_movements(
	from_date=None,
	to_date=None,
	business_point=None,
	warehouse=None,
	item=None,
	search=None,
	limit_start=0,
	limit_page_length=25,
):
	require_access("page.warehouse.movements", "read")
	from_date, to_date = from_date or nowdate(), to_date or nowdate()
	if getdate(from_date) > getdate(to_date):
		frappe.throw(_("Дата начала не может быть позже даты окончания."))
	warehouses = _warehouses(business_point, warehouse)
	filters = {
		"warehouse": ["in", warehouses or ["__none__"]],
		"posting_datetime": [
			"between",
			[
				datetime.combine(getdate(from_date), time.min),
				datetime.combine(getdate(to_date), time.max),
			],
		],
	}
	if item:
		filters["item"] = item
	elif (search or "").strip():
		query = f"%{(search or '').strip()}%"
		items = frappe.get_all(
			"Catalog Item",
			or_filters={
				"item_name": ["like", query],
				"item_code": ["like", query],
				"article": ["like", query],
			},
			pluck="name",
			limit_page_length=0,
		)
		filters["item"] = ["in", items or ["__none__"]]
	page_length = min(max(int(limit_page_length or 25), 1), 100)
	start = max(int(limit_start or 0), 0)
	rows = frappe.get_all(
		"Stock Ledger Entry",
		filters=filters,
		or_filters=_effective_ledger_or_filters(),
		fields=[
			"name",
			"posting_datetime",
			"item",
			"warehouse",
			"storage_location",
			"actual_qty",
			"incoming_rate",
			"stock_value_difference",
			"quantity_before",
			"quantity_after",
			"stock_value_after",
			"valuation_source",
			"voucher_type",
			"voucher_no",
			"voucher_detail_no",
			"is_reversal",
		],
		order_by="posting_datetime desc, creation desc",
		limit_start=start,
		limit_page_length=page_length,
	)
	metadata = _item_metadata({row.item for row in rows})
	warehouse_map = {
		row.name: row
		for row in frappe.get_all(
			"Catalog Warehouse",
			filters={"name": ["in", warehouses or ["__none__"]]},
			fields=["name", "warehouse_name", "business_point"],
		)
	}
	for row in rows:
		meta = metadata.get(row.item)
		warehouse_row = warehouse_map.get(row.warehouse)
		row.update(
			{
				"item_name": meta.item_name if meta else row.item,
				"item_code": meta.item_code if meta else None,
				"article": meta.article if meta else None,
				"uom": meta.stock_uom if meta else None,
				"warehouse_name": warehouse_row.warehouse_name if warehouse_row else row.warehouse,
				"business_point": warehouse_row.business_point if warehouse_row else None,
			}
		)
	return {
		"rows": rows,
		"total": (
			frappe.get_all(
				"Stock Ledger Entry",
				filters=filters,
				or_filters=_effective_ledger_or_filters(),
				fields=["count(name) as total"],
			)[0].total
		),
		"from_date": str(from_date),
		"to_date": str(to_date),
	}


@frappe.whitelist()
def get_report_options():
	require_any_access(
		("page.warehouse.balances", "page.warehouse.turnover", "page.warehouse.movements"), "read"
	)
	warehouses = _warehouses()
	warehouse_rows = frappe.get_all(
		"Catalog Warehouse",
		filters={"name": ["in", warehouses or ["__none__"]]},
		fields=["name", "warehouse_name", "business_point"],
		order_by="warehouse_name asc",
	)
	point_names = list({row.business_point for row in warehouse_rows})
	return {
		"points": frappe.get_all(
			"Business Point",
			filters={"name": ["in", point_names or ["__none__"]]},
			fields=["name", "point_name"],
			order_by="point_name asc",
		),
		"warehouses": warehouse_rows,
		"groups": frappe.get_all(
			"Catalog Group", filters={"active": 1}, fields=["name", "group_name"], order_by="group_name asc"
		),
	}


def _warehouses(business_point=None, warehouse=None):
	filters = {"active": 1}
	scope = get_scope()
	if not scope["global"]:
		filters["business_point"] = ["in", scope["points"] or ["__none__"]]
	if business_point:
		_ensure_point(business_point)
		filters["business_point"] = business_point
	if warehouse:
		filters["name"] = warehouse
	result = frappe.get_all("Catalog Warehouse", filters=filters, pluck="name")
	if warehouse and warehouse not in result:
		frappe.throw(_("Склад недоступен"), frappe.PermissionError)
	return result


def _turnover_totals(warehouses, start, end):
	if not warehouses:
		return {}
	placeholders = ", ".join(["%s"] * len(warehouses))
	condition = effective_ledger_condition(alias="")
	rows = frappe.db.sql(
		f"""select item, warehouse,
			coalesce(sum(case when posting_datetime < %s then actual_qty else 0 end), 0) as opening_qty,
			coalesce(sum(case when posting_datetime < %s then stock_value_difference else 0 end), 0) as opening_value,
			coalesce(sum(case when posting_datetime >= %s and actual_qty >= 0 then actual_qty else 0 end), 0) as incoming_qty,
			coalesce(sum(case when posting_datetime >= %s and actual_qty >= 0 then stock_value_difference else 0 end), 0) as incoming_value,
			coalesce(sum(case when posting_datetime >= %s and actual_qty < 0 then abs(actual_qty) else 0 end), 0) as outgoing_qty,
			coalesce(sum(case when posting_datetime >= %s and actual_qty < 0 then abs(stock_value_difference) else 0 end), 0) as outgoing_value
		from `tabStock Ledger Entry`
		where warehouse in ({placeholders}) and posting_datetime<=%s and {condition}
		group by item, warehouse""",
		(start, start, start, start, start, start, *warehouses, end),
		as_dict=True,
	)
	return {
		(row.item, row.warehouse): {
			"opening_qty": flt(row.opening_qty),
			"opening_value": flt(row.opening_value),
			"incoming_qty": flt(row.incoming_qty),
			"incoming_value": flt(row.incoming_value),
			"outgoing_qty": flt(row.outgoing_qty),
			"outgoing_value": flt(row.outgoing_value),
		}
		for row in rows
	}


def _item_metadata(items):
	return {
		row.name: row
		for row in frappe.get_all(
			"Catalog Item",
			filters={"name": ["in", list(items) or ["__none__"]]},
			fields=["name", "item_code", "item_name", "article", "catalog_group", "stock_uom"],
			limit_page_length=100000,
		)
	}


def _expected_quantities(warehouses):
	orders = frappe.get_all(
		"Purchase Order",
		filters={
			"docstatus": 1,
			"order_status": ["!=", "Принято"],
			"warehouse": ["in", warehouses or ["__none__"]],
		},
		fields=["name", "warehouse"],
		limit_page_length=100000,
	)
	warehouse_by_order = {row.name: row.warehouse for row in orders}
	result = {}
	if not orders:
		return result
	for row in frappe.get_all(
		"Purchase Order Item",
		filters={"parent": ["in", list(warehouse_by_order)]},
		fields=["parent", "item", "quantity", "received_quantity"],
		limit_page_length=100000,
	):
		key = (row.item, warehouse_by_order[row.parent])
		result[key] = result.get(key, 0) + max(flt(row.quantity) - flt(row.received_quantity), 0)
	return result


def _current_balances(warehouses):
	rows = frappe.get_all(
		"Stock Balance",
		filters={"warehouse": ["in", warehouses or ["__none__"]]},
		fields=["item", "warehouse", "actual_qty", "reserved_qty", "stock_value", "last_movement_at"],
		limit_page_length=0,
	)
	locations = _stock_locations(warehouses)
	return {
		(row.item, row.warehouse): {
			"quantity": flt(row.actual_qty),
			"reserved_quantity": flt(row.reserved_qty),
			"stock_value": flt(row.stock_value),
			"last_movement_at": row.last_movement_at,
			"locations": locations.get((row.item, row.warehouse), set()),
		}
		for row in rows
	}


def _historical_balances(warehouses, end):
	if not warehouses:
		return {}
	placeholders = ", ".join(["%s"] * len(warehouses))
	condition = effective_ledger_condition(alias="")
	rows = frappe.db.sql(
		f"""select item, warehouse,
			coalesce(sum(actual_qty), 0) as quantity,
			coalesce(sum(stock_value_difference), 0) as stock_value,
			max(posting_datetime) as last_movement_at
		from `tabStock Ledger Entry`
		where warehouse in ({placeholders}) and posting_datetime <= %s and {condition}
		group by item, warehouse""",
		(*warehouses, end),
		as_dict=True,
	)
	locations = _stock_locations(warehouses, end=end)
	return {
		(row.item, row.warehouse): {
			"quantity": flt(row.quantity),
			"reserved_quantity": 0,
			"stock_value": flt(row.stock_value),
			"last_movement_at": row.last_movement_at,
			"locations": locations.get((row.item, row.warehouse), set()),
		}
		for row in rows
	}


def _stock_locations(warehouses, end=None):
	if not warehouses:
		return {}
	placeholders = ", ".join(["%s"] * len(warehouses))
	date_condition = " and posting_datetime <= %s" if end else ""
	values = (*warehouses, end) if end else tuple(warehouses)
	condition = effective_ledger_condition(alias="")
	rows = frappe.db.sql(
		f"""select item, warehouse, storage_location
		from `tabStock Ledger Entry`
		where warehouse in ({placeholders}) and storage_location is not null{date_condition}
		and {condition}
		group by item, warehouse, storage_location""",
		values,
		as_dict=True,
	)
	result = {}
	for row in rows:
		result.setdefault((row.item, row.warehouse), set()).add(row.storage_location)
	return result


def _effective_ledger_or_filters():
	active = get_active_import_batch()
	filters = [["Stock Ledger Entry", "import_batch", "is", "not set"]]
	if active:
		filters.append(["Stock Ledger Entry", "import_batch", "=", active])
	return filters


def _minimum_stock_levels(warehouses):
	rows = frappe.get_all(
		"Catalog Reorder Rule",
		filters={
			"warehouse": ["in", warehouses or ["__none__"]],
			"parenttype": "Catalog Item",
		},
		fields=["parent", "warehouse", "minimum_stock"],
		limit_page_length=0,
	)
	return {(row.parent, row.warehouse): flt(row.minimum_stock) for row in rows}


def _paginate_rows(rows, limit_start=0, limit_page_length=25):
	page_length = cint(limit_page_length)
	if page_length == 0:
		return rows
	page_length = min(max(page_length or 25, 1), 100)
	start = max(cint(limit_start or 0), 0)
	return rows[start : start + page_length]
