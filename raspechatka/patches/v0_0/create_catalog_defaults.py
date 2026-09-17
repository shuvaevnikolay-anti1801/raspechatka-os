import frappe


def execute():
	_create_units()
	_create_price_types()
	_create_groups()
	warehouse = _create_demo_network()
	_create_demo_catalog(warehouse)


def _insert_if_missing(doctype, name, values):
	if frappe.db.exists(doctype, name):
		return name

	doc = frappe.get_doc({"doctype": doctype, **values})
	doc.insert(ignore_permissions=True)
	return doc.name


def _create_units():
	units = [
		("Штука", "шт", 0),
		("Услуга", "усл", 0),
		("Лист", "л.", 0),
		("Квадратный метр", "м²", 1),
		("Погонный метр", "пог. м", 1),
		("Килограмм", "кг", 1),
		("Комплект", "компл.", 0),
		("Упаковка", "упак.", 0),
	]
	for unit_name, symbol, allow_fraction in units:
		_insert_if_missing(
			"Catalog Unit",
			unit_name,
			{"unit_name": unit_name, "symbol": symbol, "allow_fraction": allow_fraction, "active": 1},
		)


def _create_price_types():
	for price_type_name, purpose in (("Розничная", "Selling"), ("Закупочная", "Buying")):
		_insert_if_missing(
			"Catalog Price Type",
			price_type_name,
			{"price_type_name": price_type_name, "purpose": purpose, "currency": "RUB", "active": 1},
		)


def _create_groups():
	groups = [
		("Все товары и услуги", None, 1),
		("Товары", "Все товары и услуги", 1),
		("Услуги", "Все товары и услуги", 1),
		("Комплекты", "Все товары и услуги", 1),
		("Расходные материалы", "Товары", 0),
		("Готовая продукция", "Товары", 0),
		("Копировальные услуги", "Услуги", 0),
	]
	for group_name, parent, is_group in groups:
		_insert_if_missing(
			"Catalog Group",
			group_name,
			{"group_name": group_name, "parent_catalog_group": parent, "is_group": is_group, "active": 1},
		)


def _create_demo_network():
	_insert_if_missing(
		"Organization",
		"CENTRAL",
		{
			"organization_code": "CENTRAL",
			"organization_name": "Распечатка — центральная компания",
			"organization_type": "Central",
			"active": 1,
		},
	)
	entity = _insert_if_missing(
		"Business Entity",
		"Тестовое ИП",
		{
			"short_name": "Тестовое ИП",
			"organization": "CENTRAL",
			"last_name": "Тестовый",
			"first_name": "Предприниматель",
			"inn": "000000000000",
			"registration_address": "Адрес не указан",
			"tax_system": "Патент",
			"active": 1,
		},
	)
	_insert_if_missing(
		"Business Point",
		"DEMO-POINT",
		{
			"point_code": "DEMO-POINT",
			"point_name": "Тестовая точка",
			"organization": "CENTRAL",
			"business_entity": entity,
			"point_type": "Copy Center",
			"city": "Ярославль",
			"address": "Адрес не указан",
			"active": 1,
		},
	)
	warehouse = frappe.db.get_value("Catalog Warehouse", {"business_point": "DEMO-POINT"}, "name")
	if not warehouse:
		warehouse = _insert_if_missing(
			"Catalog Warehouse",
			"DEMO-WH",
			{
				"warehouse_code": "DEMO-WH",
				"warehouse_name": "Склад тестовой точки",
				"business_point": "DEMO-POINT",
				"warehouse_type": "Sales",
				"active": 1,
			},
		)
	return warehouse


def _create_demo_catalog(warehouse):
	_insert_if_missing(
		"Catalog Item",
		"MAT-PAPER-A4",
		{
			"item_code": "MAT-PAPER-A4",
			"item_name": "Бумага A4",
			"item_type": "Product",
			"catalog_group": "Расходные материалы",
			"stock_uom": "Лист",
			"active": 1,
			"track_inventory": 1,
			"prices": [
				{"price_type": "Закупочная", "rate": 0.8},
				{"price_type": "Розничная", "rate": 2.0},
			],
			"reorder_rules": [
				{"warehouse": warehouse, "minimum_stock": 500, "reorder_quantity": 2500}
			],
		},
	)
	_insert_if_missing(
		"Catalog Item",
		"SRV-PRINT-COLOR-A4",
		{
			"item_code": "SRV-PRINT-COLOR-A4",
			"item_name": "Печать цветная A4",
			"item_type": "Service",
			"catalog_group": "Копировальные услуги",
			"stock_uom": "Услуга",
			"active": 1,
			"track_inventory": 0,
			"receipt_subject": "Услуга",
			"prices": [{"price_type": "Розничная", "rate": 40.0}],
		},
	)
	_insert_if_missing(
		"Catalog Item",
		"SET-PRINT-COLOR-A4",
		{
			"item_code": "SET-PRINT-COLOR-A4",
			"item_name": "Печать цветная A4 с бумагой",
			"item_type": "Bundle",
			"catalog_group": "Комплекты",
			"stock_uom": "Комплект",
			"active": 1,
			"track_inventory": 0,
			"bundle_components": [
				{"item": "MAT-PAPER-A4", "quantity": 1, "uom": "Лист"},
				{"item": "SRV-PRINT-COLOR-A4", "quantity": 1, "uom": "Услуга"},
			],
			"prices": [{"price_type": "Розничная", "rate": 40.0}],
		},
	)

	for item in ("MAT-PAPER-A4", "SRV-PRINT-COLOR-A4", "SET-PRINT-COLOR-A4"):
		assortment_name = f"DEMO-POINT-{item}"
		_insert_if_missing(
			"Catalog Assortment",
			assortment_name,
			{
				"item": item,
				"business_point": "DEMO-POINT",
				"default_warehouse": warehouse,
				"enabled": 1,
				"visible_in_pos": 1,
			},
		)
