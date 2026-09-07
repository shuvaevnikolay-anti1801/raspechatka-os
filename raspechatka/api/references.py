import json

import frappe
from frappe import _
from frappe.utils import cint
from raspechatka.access import LEVELS, get_access_level, get_scope, require_access
from raspechatka.dadata import find_bank, find_party
from raspechatka.requisites import digits, is_valid_bic, is_valid_inn


REFERENCE_CONFIG = {
	"organizations": {
		"doctype": "Organization", "fields": ["name", "organization_name", "organization_type", "phone", "email", "active"],
		"search_fields": ("organization_name", "phone", "email"), "order_by": "organization_name asc",
	},
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
		"fields": ["name", "short_name", "full_name", "internal_code", "organization", "inn", "phone", "email", "tax_system", "active"],
		"search_fields": ("short_name", "full_name", "internal_code", "inn", "ogrnip", "phone", "email"),
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

AREA_BY_REFERENCE = {
	"organizations": "references.network", "entities": "references.network", "points": "references.network", "warehouses": "references.storage",
	"clients": "references.clients", "suppliers": "references.suppliers", "employees": "references.employees", "positions": "references.employees",
	"catalog-groups": "references.catalog", "catalog-units": "references.catalog", "price-types": "references.catalog",
	"payment-methods": "references.finance", "pos-workplaces": "references.finance", "cash-registers": "references.finance", "financial-articles": "references.finance",
}


@frappe.whitelist()
def get_reference_list(reference, search=None, active=None):
	config = _get_config(reference)
	require_access(AREA_BY_REFERENCE[reference], "read")
	filters = {}
	if reference == "entities" and active is None:
		active = 1
	if active not in (None, ""):
		filters["active"] = cint(active)
	filters.update(_scope_filters(reference))

	or_filters = None
	if search:
		value = f"%{search.strip()}%"
		or_filters = {fieldname: ["like", value] for fieldname in config["search_fields"]}

	rows = frappe.get_all(
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
		count_by_warehouse = {}
		for cabinet in frappe.get_all("Storage Cabinet", fields=["warehouse"]):
			count_by_warehouse[cabinet.warehouse] = count_by_warehouse.get(cabinet.warehouse, 0) + 1
		for row in rows:
			row["cabinet_count"] = count_by_warehouse.get(row.name, 0)

	return rows


@frappe.whitelist()
def get_reference_detail(reference, name):
	config = _get_config(reference)
	require_access(AREA_BY_REFERENCE[reference], "read")
	if not frappe.db.exists(config["doctype"], {"name": name, **_scope_filters(reference)}):
		frappe.throw(_("Запись недоступна"), frappe.PermissionError)
	doc = frappe.get_doc(config["doctype"], name)
	result = doc.as_dict(no_nulls=False)

	if reference == "entities":
		result["bank_accounts"] = frappe.get_all(
			"Business Bank Account",
			filters={"business_entity": name},
			fields=["name", "settlement_account", "currency", "bic", "bank_name", "correspondent_account", "bank_address", "active"],
			order_by="bank_name asc",
			limit_page_length=100,
		)
	elif reference == "warehouses":
		cabinets = frappe.get_all(
			"Storage Cabinet",
			filters={"warehouse": name},
			fields=["name", "cabinet_name", "cabinet_number", "active", "sort_order"],
			order_by="sort_order asc, cabinet_number asc",
			limit_page_length=500,
		)
		for cabinet in cabinets:
			cabinet["locations"] = frappe.get_all(
				"Storage Location",
				filters={"cabinet": cabinet.name},
				fields=["name", "location_name", "full_address", "active", "sort_order"],
				order_by="sort_order asc, location_name asc",
				limit_page_length=500,
			)
		result["cabinets"] = cabinets
		result["item_storage"] = frappe.get_all(
			"Catalog Item Storage",
			filters={"warehouse": name},
			fields=["name", "item", "storage_location", "full_address", "active"],
			order_by="item asc",
			limit_page_length=1000,
		)
	elif reference == "suppliers":
		result["bank_accounts"] = frappe.get_all("Supplier Bank Account", filters={"supplier": name}, fields=["name", "settlement_account", "currency", "bic", "bank_name", "correspondent_account", "active"], order_by="bank_name asc", limit_page_length=100)
		result["items"] = frappe.get_all("Catalog Item Supplier", filters={"supplier": name}, fields=["name", "item", "is_primary", "active"], order_by="is_primary desc, item asc", limit_page_length=1000)

	return result


@frappe.whitelist()
def lookup_entity_by_inn(inn):
	require_access("references.network", "read")
	inn = digits(inn)
	if len(inn) != 12 or not is_valid_inn(inn):
		frappe.throw(_("Укажите корректный 12-значный ИНН индивидуального предпринимателя"))

	suggestion = find_party(inn)
	data = suggestion.get("data") or {}
	if data.get("type") != "INDIVIDUAL":
		frappe.throw(_("По этому ИНН найдено не ИП. В этом справочнике можно создавать только ИП."))

	name = data.get("name") or {}
	fio = data.get("fio") or {}
	address = data.get("address") or {}
	state = data.get("state") or {}
	status_labels = {
		"ACTIVE": _("Действует"),
		"LIQUIDATING": _("Ликвидируется"),
		"LIQUIDATED": _("Ликвидировано"),
		"BANKRUPT": _("Банкротство"),
		"REORGANIZING": _("Реорганизация"),
	}
	full_name = name.get("full_with_opf") or name.get("full") or suggestion.get("unrestricted_value") or suggestion.get("value")
	short_name = name.get("short_with_opf") or name.get("short") or suggestion.get("value") or full_name
	return {
		"short_name": short_name,
		"full_name": full_name,
		"last_name": fio.get("surname") or "",
		"first_name": fio.get("name") or "",
		"middle_name": fio.get("patronymic") or "",
		"inn": data.get("inn") or inn,
		"ogrnip": data.get("ogrn") or "",
		"okpo": data.get("okpo") or "",
		"registration_address": address.get("unrestricted_value") or address.get("value") or "",
		"registration_status": status_labels.get(state.get("status"), state.get("status") or _("Найдено")),
	}


@frappe.whitelist()
def lookup_bank_by_bic(bic):
	require_access("references.network", "read")
	bic = digits(bic)
	if not is_valid_bic(bic):
		frappe.throw(_("БИК должен содержать 9 цифр"))

	suggestion = find_bank(bic)
	data = suggestion.get("data") or {}
	name = data.get("name") or {}
	address = data.get("address") or {}
	return {
		"bic": data.get("bic") or bic,
		"bank_name": name.get("payment") or name.get("short") or name.get("full") or suggestion.get("value") or "",
		"correspondent_account": data.get("correspondent_account") or "",
		"bank_address": address.get("unrestricted_value") or address.get("value") or "",
	}


@frappe.whitelist(methods=["POST"])
def save_reference(reference, data):
	data = frappe.parse_json(data)
	config = _get_config(reference)
	name = data.get("name")
	ptype = "write" if name else "create"
	require_access(AREA_BY_REFERENCE[reference], ptype)
	if name and not frappe.db.exists(config["doctype"], {"name": name, **_scope_filters(reference)}):
		frappe.throw(_("Запись недоступна"), frappe.PermissionError)
	_validate_payload_scope(reference, data, name)

	if reference == "entities":
		allowed = (
			"short_name", "full_name", "organization", "phone", "email", "last_name", "first_name",
			"middle_name", "inn", "ogrnip", "okpo", "registration_address", "registration_status", "tax_system", "vat_payer",
		)
	elif reference == "organizations":
		allowed = ("organization_name", "active", "phone", "email", "address")
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
	if reference == "entities" and not name:
		doc.active = 1
	if reference == "organizations" and not name:
		doc.organization_code = frappe.generate_hash(length=10).upper()
		doc.organization_type = "Franchisee"
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

	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_bank_account(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	require_access("references.network", "write" if name else "create")
	entity = data.get("business_entity") or (frappe.db.get_value("Business Bank Account", name, "business_entity") if name else None)
	_ensure_scoped_name("entities", entity)
	doc = frappe.get_doc("Business Bank Account", name) if name else frappe.new_doc("Business Bank Account")
	for fieldname in ("business_entity", "settlement_account", "currency", "bic", "bank_name", "correspondent_account", "bank_address", "active"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_supplier_bank_account(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	require_access("references.suppliers", "write" if name else "create")
	if name:
		_ensure_scoped_name("suppliers", frappe.db.get_value("Supplier Bank Account", name, "supplier"))
	supplier = data.get("supplier") or (frappe.db.get_value("Supplier Bank Account", name, "supplier") if name else None)
	_ensure_scoped_name("suppliers", supplier)
	doc = frappe.get_doc("Supplier Bank Account", name) if name else frappe.new_doc("Supplier Bank Account")
	for fieldname in ("supplier", "settlement_account", "currency", "bic", "bank_name", "correspondent_account", "active"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_item_supplier(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	require_access("references.suppliers", "write" if name else "create")
	if name:
		_ensure_scoped_name("suppliers", frappe.db.get_value("Catalog Item Supplier", name, "supplier"))
	supplier = data.get("supplier") or (frappe.db.get_value("Catalog Item Supplier", name, "supplier") if name else None)
	_ensure_scoped_name("suppliers", supplier)
	doc = frappe.get_doc("Catalog Item Supplier", name) if name else frappe.new_doc("Catalog Item Supplier")
	for fieldname in ("item", "supplier", "is_primary", "active"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_cabinet(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	require_access("references.storage", "write" if name else "create")
	if name:
		_ensure_scoped_name("warehouses", frappe.db.get_value("Storage Cabinet", name, "warehouse"))
	warehouse = data.get("warehouse") or (frappe.db.get_value("Storage Cabinet", name, "warehouse") if name else None)
	_ensure_scoped_name("warehouses", warehouse)
	doc = frappe.get_doc("Storage Cabinet", name) if name else frappe.new_doc("Storage Cabinet")
	for fieldname in ("warehouse", "cabinet_number", "active", "sort_order"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_storage_location(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	require_access("references.storage", "write" if name else "create")
	if name:
		old_cabinet = frappe.db.get_value("Storage Location", name, "cabinet")
		_ensure_scoped_name("warehouses", frappe.db.get_value("Storage Cabinet", old_cabinet, "warehouse"))
	cabinet = data.get("cabinet") or (frappe.db.get_value("Storage Location", name, "cabinet") if name else None)
	warehouse = frappe.db.get_value("Storage Cabinet", cabinet, "warehouse") if cabinet else None
	_ensure_scoped_name("warehouses", warehouse)
	doc = frappe.get_doc("Storage Location", name) if name else frappe.new_doc("Storage Location")
	for fieldname in ("cabinet", "location_name", "active", "sort_order"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_item_storage(data):
	data = frappe.parse_json(data)
	name = data.get("name")
	require_access("references.storage", "write" if name else "create")
	if name:
		_ensure_scoped_name("warehouses", frappe.db.get_value("Catalog Item Storage", name, "warehouse"))
	warehouse = data.get("warehouse") or (frappe.db.get_value("Catalog Item Storage", name, "warehouse") if name else None)
	_ensure_scoped_name("warehouses", warehouse)
	doc = frappe.get_doc("Catalog Item Storage", name) if name else frappe.new_doc("Catalog Item Storage")
	for fieldname in ("item", "warehouse", "storage_location", "active"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def archive_reference(reference, name, active=0):
	config = _get_config(reference)
	require_access(AREA_BY_REFERENCE[reference], "write")
	_ensure_scoped_name(reference, name)
	frappe.db.set_value(config["doctype"], name, "active", cint(active), update_modified=True)
	if reference == "points":
		frappe.db.set_value("Catalog Warehouse", {"business_point": name}, "active", cint(active), update_modified=True)
	return {"name": name, "active": cint(active)}


@frappe.whitelist(methods=["POST"])
def delete_reference(reference, name):
	config = _get_config(reference)
	require_access(AREA_BY_REFERENCE[reference], "delete")
	_ensure_scoped_name(reference, name)
	if reference == "entities":
		frappe.throw(_("ИП нельзя удалить. Переведите карточку в архив."))
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
	frappe.delete_doc(config["doctype"], name, ignore_permissions=True)
	return {"deleted": name}


@frappe.whitelist()
def get_reference_options():
	if frappe.session.user == "Guest":
		frappe.throw(_("Требуется вход в систему"), frappe.PermissionError)
	scope = get_scope()
	point_filters = {} if scope["global"] else {"name": ["in", scope["points"] or ["__none__"]]}
	entity_filters = {"active": 1} if scope["global"] else {"active": 1, "name": scope["business_entity"] or "__none__"}
	organization_filters = {"active": 1}
	if not scope["global"]:
		organization = frappe.db.get_value("Business Entity", scope["business_entity"], "organization") if scope["business_entity"] else None
		organization_filters["name"] = organization or "__none__"
	supplier_filters = {"active": 1, **_scope_filters("suppliers")}
	return {
		"organizations": frappe.get_all("Organization", filters=organization_filters, fields=["name", "organization_name"], order_by="organization_name asc", limit_page_length=500) if LEVELS.get(get_access_level("references.network"), 0) else [],
		"entities": frappe.get_all("Business Entity", filters=entity_filters, fields=["name", "short_name"], order_by="short_name asc", limit_page_length=500),
		"bank_accounts": frappe.get_all("Business Bank Account", filters={"active": 1, **({} if scope["global"] else {"business_entity": scope["business_entity"] or "__none__"})}, fields=["name", "business_entity", "bank_name", "settlement_account"], order_by="bank_name asc", limit_page_length=500),
		"products": frappe.get_all("Catalog Item", filters={"active": 1, "item_type": "Product"}, fields=["name", "item_name", "item_code"], order_by="item_name asc", limit_page_length=1000) if LEVELS.get(get_access_level("references.catalog"), 0) else [],
		"points": frappe.get_all("Business Point", filters={"active": 1, **point_filters}, fields=["name", "point_name", "business_entity"], order_by="point_name asc", limit_page_length=500),
		"positions": frappe.get_all("Position", filters={"active": 1}, fields=["name", "position_name"], order_by="position_name asc", limit_page_length=500),
		"suppliers": frappe.get_all("Catalog Supplier", filters=supplier_filters, fields=["name", "supplier_name"], order_by="supplier_name asc", limit_page_length=500) if LEVELS.get(get_access_level("references.suppliers"), 0) else [],
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


def _ensure_scoped_name(reference, name):
	if not name:
		frappe.throw(_("Не указана связанная запись"))
	config = _get_config(reference)
	if not frappe.db.exists(config["doctype"], {"name": name, **_scope_filters(reference)}):
		frappe.throw(_("Запись недоступна"), frappe.PermissionError)


def _validate_payload_scope(reference, data, name=None):
	scope = get_scope()
	if scope["global"]:
		return
	entity = scope["business_entity"]
	points = set(scope["points"] or [])
	if reference == "organizations" and not name:
		frappe.throw(_("Создавать участников сети может только администратор сети"), frappe.PermissionError)
	if reference == "entities":
		organization = frappe.db.get_value("Business Entity", entity, "organization") if entity else None
		if data.get("organization") != organization:
			frappe.throw(_("Можно использовать только свою организацию"), frappe.PermissionError)
	if reference == "points" and data.get("business_entity") != entity:
		frappe.throw(_("Можно использовать только своё юридическое лицо"), frappe.PermissionError)
	if reference == "clients" and data.get("registration_point") not in points:
		frappe.throw(_("Можно выбрать только назначенную точку"), frappe.PermissionError)
	if reference == "suppliers":
		old_scope = frappe.db.get_value("Catalog Supplier", name, "scope") if name else None
		if old_scope == "Network" or data.get("scope") == "Network":
			frappe.throw(_("Общесетевых поставщиков изменяет только администратор сети"), frappe.PermissionError)
		if data.get("business_entity") != entity:
			frappe.throw(_("Можно использовать только своё юридическое лицо"), frappe.PermissionError)
	if reference == "employees":
		if data.get("business_entity") != entity or data.get("access_profile") == "Network Admin":
			frappe.throw(_("Недопустимое назначение сотрудника"), frappe.PermissionError)
		assigned = {row.get("business_point") for row in data.get("assigned_points") or []}
		if not assigned.issubset(points):
			frappe.throw(_("Сотруднику можно назначить только доступные вам точки"), frappe.PermissionError)


def _scope_filters(reference):
	scope = get_scope()
	if reference == "organizations":
		filters = {"organization_type": "Franchisee"}
		if not scope["global"]:
			organization = frappe.db.get_value("Business Entity", scope["business_entity"], "organization") if scope["business_entity"] else None
			filters["name"] = organization or "__none__"
		return filters
	if scope["global"]:
		return {}
	if reference == "entities":
		return {"name": scope["business_entity"] or "__none__"}
	if reference == "points":
		return {"name": ["in", scope["points"] or ["__none__"]]}
	if reference in ("warehouses", "pos-workplaces", "cash-registers"):
		return {"business_point": ["in", scope["points"] or ["__none__"]]}
	if reference == "suppliers":
		allowed = frappe.get_all("Catalog Supplier", or_filters={"scope": "Network", "business_entity": scope["business_entity"] or "__none__"}, pluck="name")
		return {"name": ["in", allowed or ["__none__"]]}
	if reference == "employees":
		return {"business_entity": scope["business_entity"] or "__none__"}
	return {}
