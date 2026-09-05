import frappe


def execute():
	organization = frappe.db.get_value("Organization", {}, "name", order_by="creation asc")
	if not organization:
		return

	entity = _ensure_demo_entity(organization)
	for point in frappe.get_all("Business Point", fields=["name", "point_name", "business_entity", "address"]):
		updates = {}
		if not point.business_entity:
			updates["business_entity"] = entity
		if not point.address:
			updates["address"] = "Адрес не указан"
		if updates:
			frappe.db.set_value("Business Point", point.name, updates, update_modified=False)
		point_doc = frappe.get_doc("Business Point", point.name)
		if not point_doc.working_hours:
			for index, weekday in enumerate(("Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье")):
				is_working = index < 5
				point_doc.append("working_hours", {
					"weekday": weekday,
					"is_working": is_working,
					"opens_at": "09:00:00" if is_working else None,
					"closes_at": "20:00:00" if is_working else None,
				})
			point_doc.save(ignore_permissions=True)

		warehouse = frappe.db.get_value("Catalog Warehouse", {"business_point": point.name}, "name")
		if not warehouse:
			warehouse = frappe.get_doc({
				"doctype": "Catalog Warehouse",
				"warehouse_name": f"Склад — {point.point_name}",
				"business_point": point.name,
				"active": 1,
			}).insert(ignore_permissions=True).name

		_create_demo_locations(warehouse)


def _ensure_demo_entity(organization):
	entity = frappe.db.get_value("Business Entity", {"organization": organization}, "name")
	if entity:
		return entity

	return frappe.get_doc({
		"doctype": "Business Entity",
		"short_name": "Тестовое ИП",
		"organization": organization,
		"active": 1,
		"last_name": "Тестовый",
		"first_name": "Предприниматель",
		"inn": "000000000000",
		"tax_system": "Патент",
	}).insert(ignore_permissions=True).name


def _create_demo_locations(warehouse):
	if frappe.db.exists("Storage Cabinet", {"warehouse": warehouse}):
		return

	cabinet = frappe.get_doc({
		"doctype": "Storage Cabinet",
		"warehouse": warehouse,
		"cabinet_number": 1,
		"active": 1,
		"sort_order": 1,
	}).insert(ignore_permissions=True)

	for index, location_name in enumerate(("Полка верхняя", "Полка нижняя"), start=1):
		frappe.get_doc({
			"doctype": "Storage Location",
			"cabinet": cabinet.name,
			"location_name": location_name,
			"active": 1,
			"sort_order": index,
		}).insert(ignore_permissions=True)
