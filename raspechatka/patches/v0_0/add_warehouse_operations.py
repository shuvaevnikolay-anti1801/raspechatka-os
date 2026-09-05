import frappe


def execute():
	code = "warehouse.operations"
	if not frappe.db.exists("Access Area", code):
		frappe.get_doc({
			"doctype": "Access Area",
			"area_code": code,
			"area_name": "Складские документы",
			"route": "/warehouse/receipts",
			"sort_order": 85,
			"active": 1,
			"system_area": 1,
		}).insert(ignore_permissions=True)
	levels = {
		"Raspechatka Network Admin": "Admin",
		"Raspechatka Franchise Owner": "Edit",
		"Raspechatka Point Manager": "Edit",
		"Raspechatka Cashier": "View",
	}
	doc = frappe.get_single("Raspechatka Access Settings")
	existing = {(row.role, row.access_area) for row in doc.rules}
	for role, level in levels.items():
		if (role, code) not in existing:
			doc.append("rules", {"role": role, "access_area": code, "access_level": level})
	doc.save(ignore_permissions=True)
