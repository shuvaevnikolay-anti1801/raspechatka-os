import frappe


def execute():
	if not frappe.db.table_exists("POS Order") or not frappe.db.has_column(
		"POS Order", "customer_order_number"
	):
		return
	rows = frappe.db.sql(
		"""select name, business_point, phone, customer_order_number, status
        from `tabPOS Order` order by coalesce(created_at, creation), order_number, name""",
		as_dict=True,
	)
	used = {}
	for row in rows:
		if row.status in ("New", "In Progress", "Ready") and row.customer_order_number:
			used.setdefault(row.business_point, set()).add(row.customer_order_number)
	for row in rows:
		if row.status not in ("New", "In Progress", "Ready") or row.customer_order_number:
			continue
		base = "".join(ch for ch in str(row.phone or "") if ch.isdigit())[-4:].zfill(4)
		point_used = used.setdefault(row.business_point, set())
		suffix = 0
		while (f"{base} ({suffix})" if suffix else base) in point_used:
			suffix += 1
		number = f"{base} ({suffix})" if suffix else base
		frappe.db.set_value("POS Order", row.name, "customer_order_number", number, update_modified=False)
		point_used.add(number)
