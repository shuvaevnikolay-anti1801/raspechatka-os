import frappe

from raspechatka.pricing import materialize_legacy_point_prices


def execute():
	"""Freeze every legacy-effective assortment price as a point-owned price."""
	for point in frappe.get_all("Business Point", filters={"active": 1}, pluck="name"):
		items = frappe.get_all(
			"Catalog Assortment",
			filters={"business_point": point, "enabled": 1},
			pluck="item",
			limit_page_length=0,
		)
		materialize_legacy_point_prices(items, [point])
