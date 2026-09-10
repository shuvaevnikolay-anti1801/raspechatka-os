import frappe


def execute():
	"""Add operational targets used by the control center."""
	frappe.reload_doc("raspechatka_os", "doctype", "finance_budget")
