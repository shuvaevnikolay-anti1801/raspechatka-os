import frappe


def execute():
	"""Make the existing network catalog available at every active point.

	POS bootstrap intentionally returns only Catalog Assortment rows enabled and
	visible for the requested Business Point. Older catalog items were created
	before point assortment was filled, so those items were invisible to POS.
	"""
	points = frappe.get_all("Business Point", filters={"active": 1}, pluck="name")
	items = frappe.get_all("Catalog Item", filters={"active": 1}, pluck="name")

	for point in points:
		for item in items:
			if frappe.db.exists("Catalog Assortment", {"business_point": point, "item": item}):
				continue
			frappe.get_doc(
				{
					"doctype": "Catalog Assortment",
					"business_point": point,
					"item": item,
					"enabled": 1,
					"visible_in_pos": 1,
				}
			).insert(ignore_permissions=True)
