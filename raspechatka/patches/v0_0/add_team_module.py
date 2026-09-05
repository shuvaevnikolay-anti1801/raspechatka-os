import frappe


AREAS = (
	("team.employees", "Сотрудники", "/team", 61),
	("team.schedule", "График сотрудников", "/team/schedule", 62),
	("team.payroll", "Зарплата сотрудников", "/team/payroll", 63),
	("team.motivation", "Премии и мотивация", "/team/bonuses", 64),
	("team.hr", "Кадры и документы", "/team/hr", 65),
)

LEVELS = {
	"Raspechatka Network Admin": ("Admin", "Admin", "Admin", "Admin", "Admin"),
	"Raspechatka Franchise Owner": ("Edit", "Edit", "Edit", "Edit", "Edit"),
	"Raspechatka Point Manager": ("View", "Edit", "None", "View", "None"),
	"Raspechatka Cashier": ("None", "View", "None", "View", "None"),
}


def execute():
	for code, label, route, order in AREAS:
		if not frappe.db.exists("Access Area", code):
			frappe.get_doc({
				"doctype": "Access Area",
				"area_code": code,
				"area_name": label,
				"route": route,
				"sort_order": order,
				"active": 1,
				"system_area": 1,
			}).insert(ignore_permissions=True)

	doc = frappe.get_single("Raspechatka Access Settings")
	existing = {(row.role, row.access_area) for row in doc.rules}
	for role, levels in LEVELS.items():
		for area, level in zip(AREAS, levels):
			if (role, area[0]) not in existing:
				doc.append("rules", {"role": role, "access_area": area[0], "access_level": level})
	doc.save(ignore_permissions=True)

	for values in (
		{"shift_code": "MORNING", "shift_name": "Утро", "start_time": "08:00:00", "end_time": "14:00:00", "paid_hours": 6, "active": 1},
		{"shift_code": "EVENING", "shift_name": "Вечер", "start_time": "14:00:00", "end_time": "20:00:00", "paid_hours": 6, "active": 1},
	):
		if not frappe.db.exists("Shift Template", values["shift_code"]):
			frappe.get_doc({"doctype": "Shift Template", **values}).insert(ignore_permissions=True)
