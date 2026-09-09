# ruff: noqa: RUF001
import frappe
from frappe import _
from frappe.utils import cint, now_datetime, nowdate

from raspechatka.access import get_scope, require_access
from raspechatka.api.warehouse import _ensure_point, _ensure_supplier, _options
from raspechatka.stock import get_average_rate, get_balance


DOCUMENTS = {
	"write-offs": {
		"doctype": "Stock Write Off",
		"access_area": "page.warehouse.write_offs",
		"date_field": "posting_datetime",
		"fields": ("posting_datetime", "business_entity", "business_point", "warehouse", "reason", "remarks"),
		"item_fields": ("item", "uom", "storage_location", "quantity"),
	},
	"inventories": {
		"doctype": "Stock Inventory",
		"access_area": "page.warehouse.inventories",
		"date_field": "posting_datetime",
		"fields": ("posting_datetime", "business_entity", "business_point", "warehouse", "reason", "remarks"),
		"item_fields": ("item", "uom", "storage_location", "book_quantity", "counted_quantity", "valuation_rate"),
	},
	"purchase-orders": {
		"doctype": "Purchase Order",
		"access_area": "page.warehouse.purchase_orders",
		"date_field": "order_date",
		"fields": ("order_date", "expected_date", "payment_due_date", "business_entity", "business_point", "warehouse", "supplier", "remarks"),
		"item_fields": ("item", "uom", "quantity", "rate"),
	},
}


@frappe.whitelist()
def get_documents(kind, search=None, status=None, business_point=None):
	config = _config(kind)
	require_access(config["access_area"], "read")
	filters = _scope_filters()
	if status not in (None, ""):
		filters["docstatus"] = cint(status)
	if business_point:
		_ensure_point(business_point)
		filters["business_point"] = business_point
	or_filters = None
	if search:
		value = f"%{search.strip()}%"
		or_filters = {"name": ["like", value]}
		if kind == "purchase-orders":
			or_filters["supplier"] = ["like", value]
		else:
			or_filters["reason"] = ["like", value]
	fields = ["name", config["date_field"], "business_point", "warehouse", "docstatus", "modified"]
	if kind == "write-offs":
		fields += ["reason", "total_quantity", "total_amount"]
	elif kind == "inventories":
		fields += ["reason", "total_lines", "surplus_amount", "shortage_amount"]
	else:
		fields += ["supplier", "expected_date", "payment_due_date", "order_status", "payment_status", "total_quantity", "received_quantity", "total_amount", "paid_amount", "outstanding_amount"]
	return frappe.get_all(config["doctype"], filters=filters, or_filters=or_filters, fields=fields, order_by=f"{config['date_field']} desc", limit_page_length=500)


@frappe.whitelist()
def get_document(kind, name=None):
	config = _config(kind)
	require_access(config["access_area"], "read")
	if name:
		if not frappe.db.exists(config["doctype"], {"name": name, **_scope_filters()}):
			frappe.throw(_("Документ недоступен"), frappe.PermissionError)
		doc = frappe.get_doc(config["doctype"], name).as_dict(no_nulls=False)
		if kind == "purchase-orders":
			from raspechatka.api.supplier_settlements import get_payment_context

			doc["related_receipts"] = frappe.get_all("Stock Receipt", filters={"purchase_order": name}, fields=["name", "posting_datetime", "total_quantity", "total_amount", "docstatus"], order_by="posting_datetime desc")
			doc.update(get_payment_context(name))
	else:
		doc = {"docstatus": 0, "items": []}
		if kind == "purchase-orders":
			doc.update(
				{"order_date": nowdate(), "payment_status": "Не оплачено", "paid_amount": 0, "outstanding_amount": 0}
			)
		else:
			doc["posting_datetime"] = now_datetime().strftime("%Y-%m-%dT%H:%M")
		if kind == "inventories":
			doc["reason"] = "Плановая инвентаризация"
	options = _options()
	if not name and options["points"]:
		point = options["points"][0]
		doc.update({"business_entity": point.business_entity, "business_point": point.name})
		doc["warehouse"] = next((row.name for row in options["warehouses"] if row.business_point == point.name), None)
	return {"doc": doc, "options": options}


@frappe.whitelist(methods=["POST"])
def save_document(kind, data):
	config = _config(kind)
	data = frappe.parse_json(data)
	name = data.get("name")
	require_access(config["access_area"], "write" if name else "create")
	if name:
		if not frappe.db.exists(config["doctype"], {"name": name, "docstatus": 0, **_scope_filters()}):
			frappe.throw(_("Изменять можно только доступный черновик."))
		doc = frappe.get_doc(config["doctype"], name)
	else:
		doc = frappe.new_doc(config["doctype"])
	for fieldname in config["fields"]:
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	_ensure_point(doc.business_point)
	if kind == "purchase-orders":
		_ensure_supplier(doc.supplier)
	doc.set("items", [])
	for row in data.get("items") or []:
		doc.append("items", {key: row.get(key) for key in config["item_fields"]})
	doc.flags.ignore_permissions = True
	doc.save()
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def submit_document(kind, name):
	config = _config(kind)
	require_access(config["access_area"], "write")
	_ensure_document(config["doctype"], name, 0)
	doc = frappe.get_doc(config["doctype"], name)
	doc.flags.ignore_permissions = True
	doc.submit()
	return {"name": name, "docstatus": doc.docstatus}


@frappe.whitelist(methods=["POST"])
def cancel_document(kind, name):
	config = _config(kind)
	require_access(config["access_area"], "write")
	_ensure_document(config["doctype"], name, 1)
	doc = frappe.get_doc(config["doctype"], name)
	doc.flags.ignore_permissions = True
	doc.cancel()
	return {"name": name, "docstatus": doc.docstatus}


@frappe.whitelist()
def fill_inventory(warehouse, posting_datetime=None):
	require_access("page.warehouse.inventories", "read")
	point = frappe.db.get_value(
		"Catalog Warehouse",
		{"name": warehouse, "active": 1},
		"business_point",
	)
	if not point:
		frappe.throw(_("Склад не найден или отключён"))
	_ensure_point(point)

	items = {
		row.name: row
		for row in frappe.get_all(
			"Catalog Item",
			filters={
				"active": 1,
				"track_inventory": 1,
				"item_type": ["in", ["Product", "Variant"]],
			},
			fields=["name", "item_code", "stock_uom"],
			limit_page_length=0,
		)
	}
	if not items:
		return []

	filters = {
		"warehouse": warehouse,
		"item": ["in", list(items)],
	}
	if posting_datetime:
		filters["posting_datetime"] = ["<=", posting_datetime]
	entries = frappe.get_all(
		"Stock Ledger Entry",
		filters=filters,
		fields=["item", "storage_location", "actual_qty"],
		limit_page_length=0,
	)
	quantities = {}
	for entry in entries:
		key = (entry.item, entry.storage_location or "")
		quantities[key] = quantities.get(key, 0) + float(entry.actual_qty or 0)

	configured_locations = {}
	for row in frappe.get_all(
		"Catalog Item Storage",
		filters={
			"warehouse": warehouse,
			"active": 1,
			"item": ["in", list(items)],
		},
		fields=["item", "storage_location"],
		limit_page_length=0,
	):
		configured_locations.setdefault(row.item, set()).add(row.storage_location or "")

	inventory_keys = set(quantities)
	items_with_locations = {item for item, _location in inventory_keys}
	for item in items:
		locations = configured_locations.get(item)
		if locations:
			inventory_keys.update((item, location) for location in locations)
		elif item not in items_with_locations:
			inventory_keys.add((item, ""))

	return [
		{
			"item": item,
			"item_code": items[item].item_code,
			"uom": items[item].stock_uom,
			"storage_location": location or None,
			"book_quantity": quantities.get((item, location), 0),
			"counted_quantity": quantities.get((item, location), 0),
			"valuation_rate": get_average_rate(item, warehouse, posting_datetime),
		}
		for item, location in sorted(
			inventory_keys,
			key=lambda key: (items[key[0]].item_code or "", key[0], key[1]),
		)
	]


def _config(kind):
	if kind not in DOCUMENTS:
		frappe.throw(_("Неизвестный тип складского документа."))
	return DOCUMENTS[kind]


def _scope_filters():
	scope = get_scope()
	return {} if scope["global"] else {"business_point": ["in", scope["points"] or ["__none__"]]}


def _ensure_document(doctype, name, docstatus):
	if not frappe.db.exists(doctype, {"name": name, "docstatus": docstatus, **_scope_filters()}):
		frappe.throw(_("Документ недоступен или имеет другой статус."), frappe.PermissionError)
