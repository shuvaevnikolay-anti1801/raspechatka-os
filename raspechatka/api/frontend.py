import frappe
from frappe.utils import cint


@frappe.whitelist()
def get_catalog_items(
	search=None,
	item_type=None,
	catalog_group=None,
	active=None,
	business_point=None,
	limit_start=0,
	limit_page_length=50,
):
	"""Return the catalog rows used by the standalone frontend."""
	frappe.has_permission("Catalog Item", "read", throw=True)

	limit_start = max(cint(limit_start), 0)
	limit_page_length = min(max(cint(limit_page_length), 1), 200)
	filters = {}

	if item_type:
		filters["item_type"] = item_type
	if catalog_group:
		filters["catalog_group"] = catalog_group
	if active not in (None, ""):
		filters["active"] = cint(active)

	if business_point:
		frappe.has_permission("Catalog Assortment", "read", throw=True)
		assortment_items = frappe.get_all(
			"Catalog Assortment",
			filters={"business_point": business_point, "enabled": 1},
			pluck="item",
		)
		if not assortment_items:
			return {"items": [], "has_more": False}
		filters["name"] = ["in", assortment_items]

	or_filters = None
	if search:
		value = f"%{search.strip()}%"
		or_filters = {
			"item_name": ["like", value],
			"item_code": ["like", value],
			"article": ["like", value],
		}

	rows = frappe.get_list(
		"Catalog Item",
		fields=[
			"name",
			"item_code",
			"item_name",
			"item_type",
			"catalog_group",
			"stock_uom",
			"active",
			"article",
		],
		filters=filters,
		or_filters=or_filters,
		order_by="item_name asc",
		limit_start=limit_start,
		limit_page_length=limit_page_length + 1,
	)

	return {
		"items": rows[:limit_page_length],
		"has_more": len(rows) > limit_page_length,
	}


@frappe.whitelist()
def get_catalog_filters():
	frappe.has_permission("Catalog Item", "read", throw=True)

	return {
		"groups": frappe.get_list(
			"Catalog Group",
			filters={"active": 1},
			fields=["name", "group_name"],
			order_by="group_name asc",
			limit_page_length=500,
		),
		"business_points": frappe.get_list(
			"Business Point",
			filters={"active": 1},
			fields=["name", "point_name", "city"],
			order_by="point_name asc",
			limit_page_length=500,
		),
	}
