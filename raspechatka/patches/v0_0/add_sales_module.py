import frappe


AREAS = (
	("sales.analytics", "Продажи: точки и аналитика", "/sales", 90),
	("sales.shifts", "Продажи: смены", "/sales/shifts", 91),
	("sales.receipts", "Продажи: чеки и возвраты", "/sales/receipts", 92),
	("sales.cash", "Продажи: внесения и выплаты", "/sales/cash", 93),
	("sales.audit", "Продажи: действия кассира", "/sales/actions", 94),
	("sales.integration", "Продажи: подключение кассы", "/sales/integration", 95),
)

LEVELS = {
	"Raspechatka Network Admin": ("Admin", "Admin", "Admin", "Admin", "Admin", "Admin"),
	"Raspechatka Franchise Owner": ("View", "View", "View", "View", "View", "Admin"),
	"Raspechatka Point Manager": ("View", "View", "View", "Edit", "View", "None"),
	"Raspechatka Cashier": ("View", "View", "View", "View", "None", "None"),
}


def execute():
	for code, label, route, order in AREAS:
		if not frappe.db.exists("Access Area", code):
			frappe.get_doc({"doctype": "Access Area", "area_code": code, "area_name": label, "route": route, "sort_order": order, "active": 1, "system_area": 1}).insert(ignore_permissions=True)
	doc = frappe.get_single("Raspechatka Access Settings")
	existing = {(row.role, row.access_area) for row in doc.rules}
	for role, levels in LEVELS.items():
		for area, level in zip(AREAS, levels):
			if (role, area[0]) not in existing:
				doc.append("rules", {"role": role, "access_area": area[0], "access_level": level})
	doc.save(ignore_permissions=True)
