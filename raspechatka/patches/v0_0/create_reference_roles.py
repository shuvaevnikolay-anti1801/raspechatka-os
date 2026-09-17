import frappe


def execute():
	for role_name in (
		"Raspechatka Network Admin",
		"Raspechatka Franchise Owner",
		"Raspechatka Point Manager",
		"Raspechatka Cashier",
	):
		if not frappe.db.exists("Role", role_name):
			frappe.get_doc({"doctype": "Role", "role_name": role_name, "desk_access": 0}).insert(ignore_permissions=True)
