import json

import frappe
from frappe import _
from frappe.utils import cint


REFERENCE_CONFIG = {
	"clients": {
		"doctype": "Client", "fields": ["name", "client_name", "phone", "email", "registration_point", "personal_data_consent", "marketing_consent", "active"],
		"search_fields": ("client_name", "phone", "email"), "order_by": "client_name asc",
	},
	"suppliers": {
		"doctype": "Catalog Supplier", "fields": ["name", "supplier_name", "supplier_type", "scope", "business_entity", "inn", "phone", "email", "active"],
		"search_fields": ("supplier_name", "inn", "phone", "email"), "order_by": "supplier_name asc",
	},
	"employees": {
		"doctype": "Employee", "fields": ["name", "employee_name", "business_entity", "position", "access_profile", "phone", "email", "active"],
		"search_fields": ("employee_name", "phone", "email"), "order_by": "employee_name asc",
	},
	"positions": {
		"doctype": "Position", "fields": ["name", "position_name", "description", "active"],
		"search_fields": ("position_name", "description"), "order_by": "position_name asc",
	},
	"payment-methods": {
		"doctype": "Payment Method", "fields": ["name", "method_name", "method_type", "system_method", "active"],
		"search_fields": ("method_name",), "order_by": "method_name asc",
	},
	"pos-workplaces": {
		"doctype": "POS Workplace", "fields": ["name", "workplace_name", "business_point", "active"],
		"search_fields": ("workplace_name", "business_point"), "order_by": "workplace_name asc",
	},
	"cash-registers": {
		"doctype": "Cash Register", "fields": ["name", "register_name", "business_point", "pos_workplace", "currency", "active"],
		"search_fields": ("register_name", "business_point"), "order_by": "register_name asc",
	},
	"financial-articles": {
		"doctype": "Financial Article", "fields": ["name", "article_name", "article_type", "parent_financial_article", "is_group", "system_article", "active"],
		"search_fields": ("article_name", "description"), "order_by": "lft asc",
	},
	"catalog-groups": {
		"doctype": "Catalog Group", "fields": ["name", "group_name", "parent_catalog_group", "is_group", "active"],
		"search_fields": ("group_name",), "order_by": "lft asc",
	},
	"catalog-units": {
		"doctype": "Catalog Unit", "fields": ["name", "unit_name", "symbol", "allow_fraction", "active"],
		"search_fields": ("unit_name", "symbol"), "order_by": "unit_name asc",
	},
	"price-types": {
		"doctype": "Catalog Price Type", "fields": ["name", "price_type_name", "purpose", "currency", "active"],
		"search_fields": ("price_type_name",), "order_by": "price_type_name asc",
	},
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
	elif reference == "suppliers":
		result["bank_accounts"] = frappe.get_list("Supplier Bank Account", filters={"supplier": name}, fields=["name", "settlement_account", "currency", "bic", "bank_name", "correspondent_account", "active"], order_by="bank_name asc", limit_page_length=100)
		result["items"] = frappe.get_list("Catalog Item Supplier", filters={"supplier": name}, fields=["name", "item", "is_primary", "active"], order_by="is_primary desc, item asc", limit_page_length=1000)

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
	elif reference == "clients":
		allowed = ("active", "last_name", "first_name", "middle_name", "phone", "email", "registration_point", "personal_data_consent", "marketing_consent", "notes")
	elif reference == "suppliers":
		allowed = ("supplier_name", "supplier_type", "active", "scope", "business_entity", "phone", "email", "website", "contact_name", "contact_position", "contact_phone", "contact_email", "legal_name", "last_name", "first_name", "middle_name", "inn", "kpp", "ogrn", "ogrnip", "notes")
	elif reference == "employees":
		allowed = ("active", "last_name", "first_name", "middle_name", "phone", "email", "birth_date", "business_entity", "position", "access_profile", "notes")
	elif reference == "positions":
		allowed = ("position_name", "active", "description")
	elif reference == "financial-articles":
		allowed = ("article_name", "article_type", "parent_financial_article", "is_group", "active", "description")
	elif reference == "catalog-groups":
		allowed = ("group_name", "parent_catalog_group", "is_group", "active")
	elif reference == "catalog-units":
		allowed = ("unit_name", "symbol", "allow_fraction", "active")
	elif reference == "price-types":
		allowed = ("price_type_name", "purpose", "currency", "active")
	elif reference in ("warehouses", "payment-methods", "pos-workplaces", "cash-registers"):
		allowed = ("warehouse_name", "active")
	else:
		allowed = ()

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
	if reference == "clients" and "messengers" in data:
		doc.set("messengers", [])
		for row in data.get("messengers") or []:
			doc.append("messengers", {"messenger_type": row.get("messenger_type"), "contact": row.get("contact")})
	if reference == "employees" and "assigned_points" in data:
		doc.set("assigned_points", [])
		for row in data.get("assigned_points") or []:
			doc.append("assigned_points", {"business_point": row.get("business_point"), "is_default": cint(row.get("is_default"))})

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
def save_supplier_bank_account(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	frappe.has_permission("Supplier Bank Account", "write" if name else "create", name if name else None, throw=True)
	doc = frappe.get_doc("Supplier Bank Account", name) if name else frappe.new_doc("Supplier Bank Account")
	for fieldname in ("supplier", "settlement_account", "currency", "bic", "bank_name", "correspondent_account", "active"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save()
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_item_supplier(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	frappe.has_permission("Catalog Item Supplier", "write" if name else "create", name if name else None, throw=True)
	doc = frappe.get_doc("Catalog Item Supplier", name) if name else frappe.new_doc("Catalog Item Supplier")
	for fieldname in ("item", "supplier", "is_primary", "active"):
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
	for doctype in ("Organization", "Business Entity", "Business Bank Account", "Business Point", "Catalog Item", "Position", "Catalog Supplier"):
		frappe.has_permission(doctype, "read", throw=True)
	return {
		"organizations": frappe.get_list("Organization", filters={"active": 1}, fields=["name", "organization_name"], order_by="organization_name asc", limit_page_length=500),
		"entities": frappe.get_list("Business Entity", filters={"active": 1}, fields=["name", "short_name"], order_by="short_name asc", limit_page_length=500),
		"bank_accounts": frappe.get_list("Business Bank Account", filters={"active": 1}, fields=["name", "business_entity", "bank_name", "settlement_account"], order_by="bank_name asc", limit_page_length=500),
		"products": frappe.get_list("Catalog Item", filters={"active": 1, "item_type": "Product"}, fields=["name", "item_name", "item_code"], order_by="item_name asc", limit_page_length=1000),
		"points": frappe.get_list("Business Point", filters={"active": 1}, fields=["name", "point_name", "business_entity"], order_by="point_name asc", limit_page_length=500),
		"positions": frappe.get_list("Position", filters={"active": 1}, fields=["name", "position_name"], order_by="position_name asc", limit_page_length=500),
		"suppliers": frappe.get_list("Catalog Supplier", filters={"active": 1}, fields=["name", "supplier_name"], order_by="supplier_name asc", limit_page_length=500),
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
