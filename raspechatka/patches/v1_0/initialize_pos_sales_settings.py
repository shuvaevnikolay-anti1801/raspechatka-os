import frappe

from raspechatka.pos_settings import DEFAULT_POS_SALES_SETTINGS


def execute():
	"""Use documented network defaults; differing legacy point values are never sampled."""
	doc = frappe.get_single("POS Sales Settings")
	for fieldname, value in DEFAULT_POS_SALES_SETTINGS.items():
		if frappe.db.get_single_value("POS Sales Settings", fieldname) is None:
			doc.set(fieldname, value)
	doc.save(ignore_permissions=True)
