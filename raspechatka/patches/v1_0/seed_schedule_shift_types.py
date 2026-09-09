import frappe


SHIFT_TYPES = (
	{
		"code": "U",
		"legacy_code": "MORNING",
		"name": "Утро",
		"start_time": "08:00:00",
		"end_time": "14:00:00",
		"paid_hours": 6,
	},
	{
		"code": "V",
		"legacy_code": "EVENING",
		"name": "Вечер",
		"start_time": "14:00:00",
		"end_time": "20:00:00",
		"paid_hours": 6,
	},
)


def execute():
	"""Ensure the two canonical schedule shift types exist on every site."""
	for values in SHIFT_TYPES:
		name = frappe.db.get_value("Shift Template", {"shift_code": values["code"]}, "name")
		if not name:
			name = frappe.db.get_value("Shift Template", {"shift_code": values["legacy_code"]}, "name")

		doc = frappe.get_doc("Shift Template", name) if name else frappe.new_doc("Shift Template")
		doc.shift_code = values["code"]
		doc.shift_name = values["name"]
		doc.active = 1
		if not name:
			doc.start_time = values["start_time"]
			doc.end_time = values["end_time"]
			doc.paid_hours = values["paid_hours"]
		doc.save(ignore_permissions=True)

