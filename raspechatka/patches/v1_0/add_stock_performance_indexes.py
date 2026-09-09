import frappe


def execute():
	"""Add indexes used by warehouse history, movement and source lookups."""
	frappe.db.add_index(
		"Stock Ledger Entry",
		["warehouse", "posting_datetime", "creation"],
		"warehouse_posting_creation",
	)
	frappe.db.add_index(
		"Stock Ledger Entry",
		["voucher_type", "voucher_no", "voucher_detail_no"],
		"voucher_source",
	)
