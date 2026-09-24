import frappe


CASHIER_ROLE = "Raspechatka Cashier"


def execute():
	if not frappe.db.table_exists("Employee") or not frappe.db.has_column("Employee", "pos_access_enabled"):
		return
	if not frappe.db.table_exists("Raspechatka User Profile") or not frappe.db.table_exists("User"):
		return
	profiles = frappe.get_all(
		"Raspechatka User Profile",
		filters={
			"active": 1,
			"access_profile": CASHIER_ROLE,
			"linked_employee": ["is", "set"],
			"system_user": ["is", "set"],
		},
		fields=["linked_employee", "system_user"],
		limit_page_length=0,
	)
	if not profiles:
		return
	enabled_users = set(
		frappe.get_all(
			"User",
			filters={
				"name": ["in", [row.system_user for row in profiles]],
				"enabled": 1,
			},
			pluck="name",
			limit_page_length=0,
		)
	)
	candidate_employees = {
		row.linked_employee for row in profiles if row.system_user in enabled_users and row.linked_employee
	}
	if not candidate_employees:
		return
	active_employees = frappe.get_all(
		"Employee",
		filters={"name": ["in", list(candidate_employees)], "active": 1},
		pluck="name",
		limit_page_length=0,
	)
	for employee in active_employees:
		frappe.db.set_value("Employee", employee, "pos_access_enabled", 1, update_modified=False)
