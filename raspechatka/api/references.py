import json

import frappe
from frappe import _
from frappe.utils import cint


REFERENCE_CONFIG = {
	"entities": {
		"doctype": "Business Entity",
		"fields": ["name", "short_name", "organization", "inn", "phone", "email", "tax_system", "active"],
		"search_fields": ("short_name", "inn", "ogrnip", "phone", "email"),
		"order_by": "short_name asc",
	},
	"points": {
		"doctype": "Business Point",
		"fields": ["name", "point_name", "business_entity", "city", "address", "phone", "email", "active"],
		"search_fields": ("point_name", "city", "address", "phone", "email"),
		"order_by": "point_name asc",
	},
	"warehouses": {
		"doctype": "Catalog Warehouse",
		"fields": ["name", "warehouse_name", "business_point", "active"],
		"search_fields": ("warehouse_name", "business_point"),
		"order_by": "warehouse_name asc",
	},
}


@frappe.whitelist()
def get_reference_list(reference, search=None, active=None):
	config = _get_config(reference)
	frappe.has_permission(config["doctype"], "read", throw=True)
	filters = {}
	if active not in (None, ""):
		filters["active"] = cint(active)

	or_filters = None
	if search:
		value = f"%{search.strip()}%"
		or_filters = {fieldname: ["like", value] for fieldname in config["search_fields"]}

	rows = frappe.get_list(
		config["doctype"],
		fields=config["fields"],
		filters=filters,
		or_filters=or_filters,
		order_by=config["order_by"],
		limit_page_length=500,
	)

	if reference == "points":
		warehouses = {
			row.business_point: row.name
			for row in frappe.get_all("Catalog Warehouse", fields=["name", "business_point"])
		}
		for row in rows:
			row["warehouse"] = warehouses.get(row.name)
	elif reference == "warehouses":
		counts = frappe.get_all(
			"Storage Cabinet",
			fields=["warehouse", "count(name) as cabinet_count"],
			group_by="warehouse",
		)
		count_by_warehouse = {row.warehouse: row.cabinet_count for row in counts}
		for row in rows:
			row["cabinet_count"] = count_by_warehouse.get(row.name, 0)

	return rows


@frappe.whitelist()
def get_reference_detail(reference, name):
	config = _get_config(reference)
	frappe.has_permission(config["doctype"], "read", name, throw=True)
	doc = frappe.get_doc(config["doctype"], name)
	result = doc.as_dict(no_nulls=False)

	if reference == "entities":
		result["bank_accounts"] = frappe.get_list(
			"Business Bank Account",
			filters={"business_entity": name},
			fields=["name", "settlement_account", "currency", "bic", "bank_name", "correspondent_account", "bank_address", "active"],
			order_by="bank_name asc",
			limit_page_length=100,
		)
	elif reference == "warehouses":
		cabinets = frappe.get_list(
			"Storage Cabinet",
			filters={"warehouse": name},
			fields=["name", "cabinet_name", "cabinet_number", "active", "sort_order"],
			order_by="sort_order asc, cabinet_number asc",
			limit_page_length=500,
		)
		for cabinet in cabinets:
			cabinet["locations"] = frappe.get_list(
				"Storage Location",
				filters={"cabinet": cabinet.name},
				fields=["name", "location_name", "full_address", "active", "sort_order"],
				order_by="sort_order asc, location_name asc",
				limit_page_length=500,
			)
		result["cabinets"] = cabinets
		result["item_storage"] = frappe.get_list(
			"Catalog Item Storage",
			filters={"warehouse": name},
			fields=["name", "item", "storage_location", "full_address", "active"],
			order_by="item asc",
			limit_page_length=1000,
		)

	return result


@frappe.whitelist(methods=["POST"])
def save_reference(reference, data):
	data = frappe.parse_json(data)
	config = _get_config(reference)
	name = data.get("name")
	ptype = "write" if name else "create"
	frappe.has_permission(config["doctype"], ptype, name if name else None, throw=True)

	if reference == "entities":
		allowed = (
			"short_name", "organization", "active", "phone", "email", "last_name", "first_name",
			"middle_name", "inn", "ogrnip", "okpo", "registration_address", "tax_system", "vat_payer",
		)
	elif reference == "points":
		allowed = (
			"point_name", "business_entity", "active", "city", "address", "phone", "email", "timezone",
			"allow_free_price", "allow_discounts", "max_discount_percent", "allow_remove_cart_item",
			"accepts_cash", "accepts_card", "card_bank_account", "accepts_qr", "qr_bank_account",
		)
	else:
		allowed = ("warehouse_name", "active")

	doc = frappe.get_doc(config["doctype"], name) if name else frappe.new_doc(config["doctype"])
	for fieldname in allowed:
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))

	if reference == "points" and "working_hours" in data:
		doc.set("working_hours", [])
		for row in data.get("working_hours") or []:
			doc.append("working_hours", {
				"weekday": row.get("weekday"),
				"is_working": cint(row.get("is_working")),
				"opens_at": row.get("opens_at"),
				"closes_at": row.get("closes_at"),
			})

	doc.save()
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_bank_account(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	frappe.has_permission("Business Bank Account", "write" if name else "create", name if name else None, throw=True)
	doc = frappe.get_doc("Business Bank Account", name) if name else frappe.new_doc("Business Bank Account")
	for fieldname in ("business_entity", "settlement_account", "currency", "bic", "bank_name", "correspondent_account", "bank_address", "active"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save()
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_cabinet(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	frappe.has_permission("Storage Cabinet", "write" if name else "create", name if name else None, throw=True)
	doc = frappe.get_doc("Storage Cabinet", name) if name else frappe.new_doc("Storage Cabinet")
	for fieldname in ("warehouse", "cabinet_number", "active", "sort_order"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save()
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_storage_location(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	frappe.has_permission("Storage Location", "write" if name else "create", name if name else None, throw=True)
	doc = frappe.get_doc("Storage Location", name) if name else frappe.new_doc("Storage Location")
	for fieldname in ("cabinet", "location_name", "active", "sort_order"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save()
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_item_storage(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	frappe.has_permission("Catalog Item Storage", "write" if name else "create", name if name else None, throw=True)
	doc = frappe.get_doc("Catalog Item Storage", name) if name else frappe.new_doc("Catalog Item Storage")
	for fieldname in ("item", "warehouse", "storage_location", "active"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save()
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def archive_reference(reference, name, active=0):
	config = _get_config(reference)
	frappe.has_permission(config["doctype"], "write", name, throw=True)
	frappe.db.set_value(config["doctype"], name, "active", cint(active), update_modified=True)
	if reference == "points":
		frappe.db.set_value("Catalog Warehouse", {"business_point": name}, "active", cint(active), update_modified=True)
	return {"name": name, "active": cint(active)}


@frappe.whitelist(methods=["POST"])
def delete_reference(reference, name):
	config = _get_config(reference)
	frappe.has_permission(config["doctype"], "delete", name, throw=True)
	if reference == "warehouses":
		frappe.throw(_("Склад создаётся и удаляется вместе с точкой продаж"))
	if reference == "points":
		warehouse = frappe.db.get_value("Catalog Warehouse", {"business_point": name}, "name")
		if warehouse:
			if frappe.db.exists("Storage Cabinet", {"warehouse": warehouse}) or frappe.db.exists(
				"Catalog Item Storage", {"warehouse": warehouse}
			):
				frappe.throw(_("Сначала удалите адреса хранения и привязки товаров на складе точки"))
			frappe.delete_doc("Catalog Warehouse", warehouse, ignore_permissions=True)
	frappe.delete_doc(config["doctype"], name)
	return {"deleted": name}


@frappe.whitelist()
def get_reference_options():
	for doctype in ("Organization", "Business Entity", "Business Bank Account", "Catalog Item"):
		frappe.has_permission(doctype, "read", throw=True)
	return {
		"organizations": frappe.get_list("Organization", filters={"active": 1}, fields=["name", "organization_name"], order_by="organization_name asc", limit_page_length=500),
		"entities": frappe.get_list("Business Entity", filters={"active": 1}, fields=["name", "short_name"], order_by="short_name asc", limit_page_length=500),
		"bank_accounts": frappe.get_list("Business Bank Account", filters={"active": 1}, fields=["name", "business_entity", "bank_name", "settlement_account"], order_by="bank_name asc", limit_page_length=500),
		"products": frappe.get_list("Catalog Item", filters={"active": 1, "item_type": "Product"}, fields=["name", "item_name", "item_code"], order_by="item_name asc", limit_page_length=1000),
	}


@frappe.whitelist()
def get_view_preference(view_key):
	name = frappe.db.get_value("User View Preference", {"user": frappe.session.user, "view_key": view_key}, "name")
	if not name:
		return {}
	settings = frappe.db.get_value("User View Preference", name, "settings_json")
	try:
		return json.loads(settings or "{}")
	except ValueError:
		return {}


@frappe.whitelist(methods=["POST"])
def save_view_preference(view_key, settings):
	settings = frappe.parse_json(settings)
	name = frappe.db.get_value("User View Preference", {"user": frappe.session.user, "view_key": view_key}, "name")
	doc = frappe.get_doc("User View Preference", name) if name else frappe.new_doc("User View Preference")
	doc.user = frappe.session.user
	doc.view_key = view_key
	doc.settings_json = json.dumps(settings, ensure_ascii=False, separators=(",", ":"))
	doc.save(ignore_permissions=True)
	return settings


def _get_config(reference):
	config = REFERENCE_CONFIG.get(reference)
	if not config:
		frappe.throw(_("Неизвестный справочник"))
	return config
