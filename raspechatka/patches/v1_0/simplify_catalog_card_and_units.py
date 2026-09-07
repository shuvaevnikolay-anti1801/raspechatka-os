import frappe


UNIT_LINKS = (
	("Catalog Item", "stock_uom"),
	("Catalog Item Price", "uom"),
	("Catalog Bundle Component", "uom"),
	("Catalog Item Barcode", "uom"),
	("Catalog Packaging", "uom"),
	("Purchase Order Item", "uom"),
	("Sales Receipt Item", "uom"),
	("Stock Inventory Item", "uom"),
	("Stock Receipt Item", "uom"),
	("Stock Write Off Item", "uom"),
)


def execute():
	_ensure_unit("шт", allow_fraction=0)
	_ensure_unit("мес", allow_fraction=0)
	_migrate_unit_links()
	for unit in frappe.get_all("Catalog Unit", filters={"name": ["not in", ["шт", "мес"]]}, pluck="name"):
		frappe.db.set_value("Catalog Unit", unit, "active", 0, update_modified=False)
	_migrate_existing_variants()


def _ensure_unit(name, allow_fraction):
	if frappe.db.exists("Catalog Unit", name):
		frappe.db.set_value(
			"Catalog Unit",
			name,
			{"unit_name": name, "symbol": name, "allow_fraction": allow_fraction, "active": 1},
			update_modified=False,
		)
		return
	frappe.get_doc(
		{
			"doctype": "Catalog Unit",
			"unit_name": name,
			"symbol": name,
			"allow_fraction": allow_fraction,
			"active": 1,
		}
	).insert(ignore_permissions=True)


def _migrate_unit_links():
	units = frappe.get_all("Catalog Unit", fields=["name", "unit_name", "symbol"])
	for unit in units:
		if unit.name in {"шт", "мес"}:
			continue
		label = " ".join(filter(None, [unit.name, unit.unit_name, unit.symbol])).casefold()
		target = "мес" if "мес" in label else "шт"
		for doctype, fieldname in UNIT_LINKS:
			if not frappe.db.table_exists(doctype):
				continue
			for name in frappe.get_all(doctype, filters={fieldname: unit.name}, pluck="name"):
				frappe.db.set_value(doctype, name, fieldname, target, update_modified=False)


def _migrate_existing_variants():
	if not frappe.db.table_exists("Catalog Variant Value"):
		return
	variants = [
		row
		for row in frappe.get_all("Catalog Item", fields=["name", "variant_of"])
		if row.variant_of
	]
	for variant in variants:
		parent = frappe.db.get_value(
			"Catalog Item", variant.variant_of, ["catalog_group", "stock_uom"], as_dict=True
		)
		values = {"item_type": "Variant"}
		if parent:
			values.update(catalog_group=parent.catalog_group, stock_uom=parent.stock_uom)
		frappe.db.set_value("Catalog Item", variant.name, values, update_modified=False)
		if frappe.db.exists("Catalog Variant Value", {"parent": variant.name}):
			continue
		attributes = frappe.get_all(
			"Catalog Item Attribute",
			filters={"parent": variant.name},
			fields=["attribute_name", "attribute_value", "idx"],
			order_by="idx asc",
		)
		for attribute in attributes:
			frappe.get_doc(
				{
					"doctype": "Catalog Variant Value",
					"parent": variant.name,
					"parenttype": "Catalog Item",
					"parentfield": "variant_values",
					"idx": attribute.idx,
					"attribute_name": attribute.attribute_name,
					"attribute_value": attribute.attribute_value,
				}
			).db_insert()
		frappe.db.set_value("Catalog Item", variant.variant_of, "has_variants", 1, update_modified=False)
