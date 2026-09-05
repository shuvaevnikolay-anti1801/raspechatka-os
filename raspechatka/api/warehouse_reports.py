from datetime import datetime, time

import frappe
from frappe import _
from frappe.utils import flt, getdate, nowdate

from raspechatka.access import get_scope, require_access
from raspechatka.api.warehouse import _ensure_point


@frappe.whitelist()
def get_stock_balances(as_of=None, business_point=None, warehouse=None, catalog_group=None, search=None, show_zero=0):
	require_access("warehouse.operations", "read")
	as_of = as_of or nowdate()
	end = datetime.combine(getdate(as_of), time.max)
	warehouses = _warehouses(business_point, warehouse)
	entries = _ledger_entries(warehouses, end=end)
	location_names = {row.name: row.full_address for row in frappe.get_all("Storage Location", fields=["name", "full_address"], limit_page_length=100000)}
	aggregated = {}
	for entry in entries:
		key = (entry.item, entry.warehouse)
		bucket = aggregated.setdefault(key, {"quantity": 0, "stock_value": 0, "locations": set()})
		bucket["quantity"] += flt(entry.actual_qty)
		bucket["stock_value"] += flt(entry.stock_value_difference)
		if entry.storage_location:
			bucket["locations"].add(entry.storage_location)
	expected = _expected_quantities(warehouses)
	for key in expected:
		aggregated.setdefault(key, {"quantity": 0, "stock_value": 0, "locations": set()})
	metadata = _item_metadata({key[0] for key in aggregated})
	warehouse_map = {row.name: row for row in frappe.get_all("Catalog Warehouse", filters={"name": ["in", warehouses or ["__none__"]]}, fields=["name", "warehouse_name", "business_point"])}
	rows = []
	query = (search or "").strip().lower()
	for (item, warehouse_name), values in aggregated.items():
		meta = metadata.get(item)
		if not meta or (catalog_group and meta.catalog_group != catalog_group):
			continue
		if query and query not in " ".join((meta.item_name or "", meta.item_code or "", meta.article or "")).lower():
			continue
		qty = flt(values["quantity"])
		if not int(show_zero) and abs(qty) < 0.000001 and not expected.get((item, warehouse_name)):
			continue
		value = flt(values["stock_value"])
		wh = warehouse_map.get(warehouse_name)
		rows.append({
			"item": item, "item_code": meta.item_code, "item_name": meta.item_name, "article": meta.article,
			"catalog_group": meta.catalog_group, "uom": meta.stock_uom, "business_point": wh.business_point if wh else None,
			"warehouse": warehouse_name, "warehouse_name": wh.warehouse_name if wh else warehouse_name,
			"storage_location": ", ".join(sorted(location_names.get(name, name) for name in values["locations"])) or None, "quantity": qty, "expected_quantity": expected.get((item, warehouse_name), 0),
			"average_rate": flt(value / qty) if qty else 0, "stock_value": value,
		})
	rows.sort(key=lambda row: (row["catalog_group"] or "", row["item_name"], row["warehouse_name"], row["storage_location"] or ""))
	return {"rows": rows, "totals": {"quantity": sum(row["quantity"] for row in rows), "expected_quantity": sum(row["expected_quantity"] for row in rows), "stock_value": sum(row["stock_value"] for row in rows)}, "as_of": str(as_of)}


@frappe.whitelist()
def get_stock_turnover(from_date=None, to_date=None, business_point=None, warehouse=None, catalog_group=None, search=None):
	require_access("warehouse.operations", "read")
	from_date, to_date = from_date or nowdate(), to_date or nowdate()
	if getdate(from_date) > getdate(to_date):
		frappe.throw(_("Дата начала не может быть позже даты окончания."))
	start = datetime.combine(getdate(from_date), time.min)
	end = datetime.combine(getdate(to_date), time.max)
	warehouses = _warehouses(business_point, warehouse)
	entries = _ledger_entries(warehouses, end=end)
	aggregated = {}
	for entry in entries:
		key = (entry.item, entry.warehouse)
		bucket = aggregated.setdefault(key, {"opening_qty": 0, "opening_value": 0, "incoming_qty": 0, "incoming_value": 0, "outgoing_qty": 0, "outgoing_value": 0})
		qty, value = flt(entry.actual_qty), flt(entry.stock_value_difference)
		if entry.posting_datetime < start:
			bucket["opening_qty"] += qty
			bucket["opening_value"] += value
		elif qty >= 0:
			bucket["incoming_qty"] += qty
			bucket["incoming_value"] += value
		else:
			bucket["outgoing_qty"] += abs(qty)
			bucket["outgoing_value"] += abs(value)
	metadata = _item_metadata({key[0] for key in aggregated})
	warehouse_map = {row.name: row for row in frappe.get_all("Catalog Warehouse", filters={"name": ["in", warehouses or ["__none__"]]}, fields=["name", "warehouse_name", "business_point"])}
	query = (search or "").strip().lower()
	rows = []
	for (item, warehouse_name), values in aggregated.items():
		meta = metadata.get(item)
		if not meta or (catalog_group and meta.catalog_group != catalog_group):
			continue
		if query and query not in " ".join((meta.item_name or "", meta.item_code or "", meta.article or "")).lower():
			continue
		closing_qty = values["opening_qty"] + values["incoming_qty"] - values["outgoing_qty"]
		closing_value = values["opening_value"] + values["incoming_value"] - values["outgoing_value"]
		wh = warehouse_map.get(warehouse_name)
		rows.append({"item": item, "item_code": meta.item_code, "item_name": meta.item_name, "catalog_group": meta.catalog_group, "uom": meta.stock_uom, "business_point": wh.business_point if wh else None, "warehouse": warehouse_name, "warehouse_name": wh.warehouse_name if wh else warehouse_name, **values, "closing_qty": closing_qty, "closing_value": closing_value})
	rows.sort(key=lambda row: (row["catalog_group"] or "", row["item_name"], row["warehouse_name"]))
	keys = ("opening_qty", "opening_value", "incoming_qty", "incoming_value", "outgoing_qty", "outgoing_value", "closing_qty", "closing_value")
	return {"rows": rows, "totals": {key: sum(row[key] for row in rows) for key in keys}, "from_date": str(from_date), "to_date": str(to_date)}


@frappe.whitelist()
def get_report_options():
	require_access("warehouse.operations", "read")
	warehouses = _warehouses()
	warehouse_rows = frappe.get_all("Catalog Warehouse", filters={"name": ["in", warehouses or ["__none__"]]}, fields=["name", "warehouse_name", "business_point"], order_by="warehouse_name asc")
	point_names = list({row.business_point for row in warehouse_rows})
	return {
		"points": frappe.get_all("Business Point", filters={"name": ["in", point_names or ["__none__"]]}, fields=["name", "point_name"], order_by="point_name asc"),
		"warehouses": warehouse_rows,
		"groups": frappe.get_all("Catalog Group", filters={"active": 1}, fields=["name", "group_name"], order_by="group_name asc"),
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


def _ledger_entries(warehouses, end):
	return frappe.get_all("Stock Ledger Entry", filters={"warehouse": ["in", warehouses or ["__none__"]], "posting_datetime": ["<=", end]}, fields=["posting_datetime", "item", "warehouse", "storage_location", "actual_qty", "stock_value_difference"], order_by="posting_datetime asc, creation asc", limit_page_length=100000)


def _item_metadata(items):
	return {row.name: row for row in frappe.get_all("Catalog Item", filters={"name": ["in", list(items) or ["__none__"]]}, fields=["name", "item_code", "item_name", "article", "catalog_group", "stock_uom"], limit_page_length=100000)}


def _expected_quantities(warehouses):
	orders = frappe.get_all("Purchase Order", filters={"docstatus": 1, "order_status": ["!=", "Принято"], "warehouse": ["in", warehouses or ["__none__"]]}, fields=["name", "warehouse"], limit_page_length=100000)
	warehouse_by_order = {row.name: row.warehouse for row in orders}
	result = {}
	if not orders:
		return result
	for row in frappe.get_all("Purchase Order Item", filters={"parent": ["in", list(warehouse_by_order)]}, fields=["parent", "item", "quantity", "received_quantity"], limit_page_length=100000):
		key = (row.item, warehouse_by_order[row.parent])
		result[key] = result.get(key, 0) + max(flt(row.quantity) - flt(row.received_quantity), 0)
	return result
