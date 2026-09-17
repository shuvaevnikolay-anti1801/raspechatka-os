import frappe
from frappe.utils import flt


def execute():
	"""Backfill target_stock without overwriting an already migrated target."""
	if not frappe.db.table_exists("Catalog Reorder Rule"):
		return
	multiple = frappe.db.sql(
		"""select business_point, count(*) as warehouse_count
		from `tabCatalog Warehouse`
		where active = 1
		group by business_point
		having count(*) > 1""",
		as_dict=True,
	)
	if multiple:
		frappe.log_error(
			title="DEV-083: несколько активных складов у точки",
			message="\n".join(
				f"{row.business_point}: {row.warehouse_count}" for row in multiple
			),
		)
	rows = frappe.get_all(
		"Catalog Reorder Rule",
		fields=["name", "minimum_stock", "target_stock", "reorder_quantity"],
		limit_page_length=0,
	)
	for row in rows:
		minimum = max(flt(row.minimum_stock), 0)
		legacy = max(flt(row.reorder_quantity), 0)
		target = max(minimum, minimum + legacy) if legacy else minimum
		if not flt(row.target_stock):
			frappe.db.set_value(
				"Catalog Reorder Rule", row.name, "target_stock", target, update_modified=False
			)
	policy = frappe.get_single("Warehouse Policy")
	changed = False
	for field, default in (("analysis_days", 180), ("minimum_days", 30), ("target_days", 90)):
		if not policy.get(field):
			policy.set(field, default)
			changed = True
	if changed:
		policy.save(ignore_permissions=True)
