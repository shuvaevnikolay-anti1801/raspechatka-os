import frappe


def execute():
	from raspechatka.raspechatka_os.doctype.supplier_payment_allocation.supplier_payment_allocation import (
		update_purchase_order_payment_totals,
	)

	for order_name in frappe.get_all(
		"Purchase Order",
		pluck="name",
		limit_page_length=0,
	):
		update_purchase_order_payment_totals(order_name)
