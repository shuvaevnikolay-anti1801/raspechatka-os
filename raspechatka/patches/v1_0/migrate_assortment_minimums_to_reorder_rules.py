"""Copy unambiguous legacy point minimums into the canonical warehouse rule."""

import frappe
from frappe.utils import flt


def execute():
	from raspechatka.access import synchronize_access_pages

	synchronize_access_pages(copy_legacy_rules=True)
	if not frappe.db.table_exists("Catalog Assortment") or not frappe.db.table_exists("Catalog Reorder Rule"):
		return
	rows = frappe.get_all(
		"Catalog Assortment",
		filters={"default_warehouse": ["is", "set"]},
		fields=["name", "item", "business_point", "default_warehouse", "minimum_stock", "reorder_quantity"],
		limit_page_length=0,
	)
	for legacy in rows:
		minimum = flt(legacy.minimum_stock)
		quantity = flt(legacy.reorder_quantity)
		if not minimum and not quantity:
			continue
		if frappe.db.get_value("Catalog Warehouse", legacy.default_warehouse, "business_point") != legacy.business_point:
			_log_conflict(legacy, "legacy warehouse does not belong to point")
			continue
		doc = frappe.get_doc("Catalog Item", legacy.item)
		rule = next((row for row in doc.reorder_rules if row.warehouse == legacy.default_warehouse), None)
		if rule:
			if (minimum and flt(rule.minimum_stock) not in (0, minimum)) or (
				quantity and flt(rule.reorder_quantity) not in (0, quantity)
			):
				_log_conflict(legacy, "existing reorder rule has different values")
				continue
			rule.minimum_stock = flt(rule.minimum_stock) or minimum
			rule.reorder_quantity = flt(rule.reorder_quantity) or quantity
		else:
			doc.append("reorder_rules", {
				"warehouse": legacy.default_warehouse,
				"minimum_stock": minimum,
				"reorder_quantity": quantity,
			})
		doc.save(ignore_permissions=True)


def _log_conflict(row, reason):
	frappe.log_error(
		title="Catalog minimum stock migration conflict",
		message=f"Assortment {row.name}, item {row.item}, warehouse {row.default_warehouse}: {reason}",
	)
