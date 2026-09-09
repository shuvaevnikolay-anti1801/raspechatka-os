import frappe
from frappe import _
from frappe.utils import cint, now_datetime

from raspechatka.access import get_scope, require_access


@frappe.whitelist()
def get_receipts(
	search=None,
	receipt_type=None,
	status=None,
	business_point=None,
	limit_start=0,
	limit_page_length=25,
):
	require_access("page.warehouse.receipts", "read")
	filters = _receipt_scope_filters()
	if receipt_type:
		filters["receipt_type"] = receipt_type
	if status not in (None, ""):
		filters["docstatus"] = cint(status)
	if business_point:
		_ensure_point(business_point)
		filters["business_point"] = business_point
	or_filters = None
	if search:
		value = f"%{search.strip()}%"
		or_filters = {
			"name": ["like", value],
			"supplier": ["like", value],
			"supplier_document_number": ["like", value],
		}
	page_length = min(max(cint(limit_page_length or 25), 1), 100)
	start = max(cint(limit_start or 0), 0)
	return {
		"rows": frappe.get_all(
			"Stock Receipt",
			filters=filters,
			or_filters=or_filters,
			fields=[
				"name",
				"receipt_type",
				"posting_datetime",
				"business_entity",
				"business_point",
				"warehouse",
				"supplier",
				"total_quantity",
				"total_amount",
				"docstatus",
				"modified",
			],
			order_by="posting_datetime desc, creation desc",
			limit_start=start,
			limit_page_length=page_length,
		),
		"total": frappe.get_all(
			"Stock Receipt",
			filters=filters,
			or_filters=or_filters,
			fields=[{"COUNT": "*", "as": "total"}],
			limit_page_length=1,
		)[0].total,
	}


@frappe.whitelist()
def get_receipt(name=None, receipt_type="Приёмка", purchase_order=None):
	require_access("page.warehouse.receipts", "read")
	options = _options()
	if name:
		if not frappe.db.exists("Stock Receipt", {"name": name, **_receipt_scope_filters()}):
			frappe.throw(_("Документ недоступен"), frappe.PermissionError)
		doc = frappe.get_doc("Stock Receipt", name).as_dict(no_nulls=False)
	else:
		doc = {
			"receipt_type": receipt_type,
			"posting_datetime": now_datetime().strftime("%Y-%m-%dT%H:%M"),
			"items": [],
			"docstatus": 0,
		}
		if purchase_order:
			order = frappe.get_doc("Purchase Order", purchase_order)
			_ensure_point(order.business_point)
			if order.docstatus != 1:
				frappe.throw(_("Сначала проведите заказ поставщику."))
			doc.update(
				{
					"receipt_type": "Приёмка",
					"purchase_order": order.name,
					"business_entity": order.business_entity,
					"business_point": order.business_point,
					"warehouse": order.warehouse,
					"supplier": order.supplier,
				}
			)
			for row in order.items:
				remaining = max(0, row.quantity - row.received_quantity)
				if remaining:
					doc["items"].append(
						{
							"item": row.item,
							"uom": row.uom,
							"quantity": remaining,
							"rate": row.rate,
							"purchase_order_item": row.name,
						}
					)
		elif options["points"]:
			point = options["points"][0]
			doc["business_point"] = point.name
			doc["business_entity"] = point.business_entity
			doc["warehouse"] = next(
				(row.name for row in options["warehouses"] if row.business_point == point.name), None
			)
	return {"doc": doc, "options": options}


@frappe.whitelist(methods=["POST"])
def save_receipt(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	require_access("page.warehouse.receipts", "write" if name else "create")
	if name:
		if not frappe.db.exists("Stock Receipt", {"name": name, "docstatus": 0, **_receipt_scope_filters()}):
			frappe.throw(_("Изменять можно только доступный черновик."))
		doc = frappe.get_doc("Stock Receipt", name)
	else:
		doc = frappe.new_doc("Stock Receipt")
	for fieldname in (
		"receipt_type",
		"posting_datetime",
		"business_entity",
		"business_point",
		"warehouse",
		"purchase_order",
		"supplier",
		"supplier_document_number",
		"supplier_document_date",
		"reason",
		"remarks",
	):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	_ensure_point(doc.business_point)
	if doc.receipt_type == "Приёмка" and doc.supplier:
		_ensure_supplier(doc.supplier)
	doc.set("items", [])
	for row in data.get("items") or []:
		doc.append(
			"items",
			{
				key: row.get(key)
				for key in ("item", "uom", "storage_location", "quantity", "rate", "purchase_order_item")
			},
		)
	doc.flags.ignore_permissions = True
	doc.save()
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def submit_receipt(name):
	require_access("page.warehouse.receipts", "write")
	_ensure_receipt(name, 0)
	doc = frappe.get_doc("Stock Receipt", name)
	doc.flags.ignore_permissions = True
	doc.submit()
	return {"name": doc.name, "docstatus": doc.docstatus}


@frappe.whitelist(methods=["POST"])
def cancel_receipt(name):
	require_access("page.warehouse.receipts", "write")
	_ensure_receipt(name, 1)
	doc = frappe.get_doc("Stock Receipt", name)
	doc.flags.ignore_permissions = True
	doc.cancel()
	return {"name": doc.name, "docstatus": doc.docstatus}


def _ensure_receipt(name, docstatus):
	if not frappe.db.exists(
		"Stock Receipt", {"name": name, "docstatus": docstatus, **_receipt_scope_filters()}
	):
		frappe.throw(_("Документ недоступен или имеет другой статус."), frappe.PermissionError)


def _ensure_point(point):
	scope = get_scope()
	if not scope["global"] and point not in (scope["points"] or []):
		frappe.throw(_("Точка недоступна"), frappe.PermissionError)


def _receipt_scope_filters():
	scope = get_scope()
	return {} if scope["global"] else {"business_point": ["in", scope["points"] or ["__none__"]]}


def _options():
	scope = get_scope()
	point_filter = (
		{"active": 1} if scope["global"] else {"active": 1, "name": ["in", scope["points"] or ["__none__"]]}
	)
	points = frappe.get_all(
		"Business Point",
		filters=point_filter,
		fields=["name", "point_name", "business_entity"],
		order_by="point_name asc",
	)
	point_names = [row.name for row in points] or ["__none__"]
	entity_names = list({row.business_entity for row in points})
	if scope["global"]:
		entities = frappe.get_all(
			"Business Entity", filters={"active": 1}, fields=["name", "short_name"], order_by="short_name asc"
		)
	else:
		entities = frappe.get_all(
			"Business Entity",
			filters={"active": 1, "name": ["in", entity_names or ["__none__"]]},
			fields=["name", "short_name"],
			order_by="short_name asc",
		)
	warehouses = frappe.get_all(
		"Catalog Warehouse",
		filters={"active": 1, "business_point": ["in", point_names]},
		fields=["name", "warehouse_name", "business_point"],
		order_by="warehouse_name asc",
	)
	supplier_filters = _supplier_scope_filters()
	items = frappe.get_all(
		"Catalog Item",
		filters={"active": 1, "item_type": "Product", "track_inventory": 1},
		fields=["name", "item_code", "item_name", "stock_uom"],
		order_by="item_name asc",
		limit_page_length=3000,
	)
	locations = frappe.get_all(
		"Storage Location",
		filters={"active": 1, "warehouse": ["in", [row.name for row in warehouses] or ["__none__"]]},
		fields=["name", "location_name", "full_address", "warehouse"],
		order_by="full_address asc",
		limit_page_length=3000,
	)
	defaults = frappe.get_all(
		"Catalog Item Storage",
		filters={"active": 1, "warehouse": ["in", [row.name for row in warehouses] or ["__none__"]]},
		fields=["item", "warehouse", "storage_location"],
		limit_page_length=5000,
	)
	return {
		"entities": entities,
		"points": points,
		"warehouses": warehouses,
		"suppliers": frappe.get_all(
			"Catalog Supplier",
			filters=supplier_filters,
			fields=["name", "supplier_name"],
			order_by="supplier_name asc",
		),
		"items": items,
		"locations": locations,
		"storage_defaults": defaults,
	}


def _supplier_scope_filters():
	scope = get_scope()
	filters = {"active": 1}
	if not scope["global"]:
		allowed = frappe.get_all(
			"Catalog Supplier",
			or_filters={"scope": "Network", "business_entity": scope["business_entity"] or "__none__"},
			pluck="name",
		)
		filters["name"] = ["in", allowed or ["__none__"]]
	return filters


def _ensure_supplier(supplier):
	if not frappe.db.exists("Catalog Supplier", {"name": supplier, "active": 1}):
		frappe.throw(_("Поставщик недоступен"), frappe.PermissionError)
	scope = get_scope()
	if scope["global"]:
		return
	allowed = frappe.get_all(
		"Catalog Supplier",
		or_filters={"scope": "Network", "business_entity": scope["business_entity"] or "__none__"},
		pluck="name",
	)
	if supplier not in allowed:
		frappe.throw(_("Поставщик недоступен"), frappe.PermissionError)
