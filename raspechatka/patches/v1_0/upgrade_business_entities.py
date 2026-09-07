import hashlib

import frappe


def execute():
	if not frappe.db.table_exists("Business Entity"):
		return

	for row in frappe.get_all("Business Entity", fields=["name", "short_name", "full_name", "internal_code"]):
		updates = {}
		if not row.full_name:
			updates["full_name"] = row.short_name
		if not row.internal_code:
			digest = hashlib.sha1(row.name.encode("utf-8"), usedforsecurity=False).hexdigest()[:12].upper()
			updates["internal_code"] = f"IP-{digest}"
		if updates:
			frappe.db.set_value("Business Entity", row.name, updates, update_modified=False)
