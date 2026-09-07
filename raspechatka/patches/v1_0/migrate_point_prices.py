import frappe


def execute():
	price_type = frappe.db.get_value(
		"Catalog Price Type",
		{"active": 1, "purpose": "Selling"},
		"name",
		order_by="creation asc",
	)
	if not price_type:
		return

	points = frappe.get_all("Business Point", filters={"active": 1}, pluck="name")
	for point in points:
		if not frappe.db.get_value("Business Point", point, "default_price_type"):
			frappe.db.set_value(
				"Business Point",
				point,
				"default_price_type",
				price_type,
				update_modified=False,
			)

	price_rows = frappe.get_all(
		"Catalog Item Price",
		fields=["name", "parent", "currency", "uom"],
		limit_page_length=100000,
	)
	item_units = {}
	for row in price_rows:
		if row.parent not in item_units:
			item_units[row.parent] = frappe.db.get_value("Catalog Item", row.parent, "stock_uom")
		updates = {}
		if not row.currency:
			updates["currency"] = "RUB"
		if not row.uom:
			updates["uom"] = item_units[row.parent]
		if updates:
			frappe.db.set_value("Catalog Item Price", row.name, updates, update_modified=False)

	assortments = frappe.get_all(
		"Catalog Assortment",
		fields=["item", "business_point", "local_sale_price"],
		limit_page_length=100000,
	)
	by_item = {}
	for row in assortments:
		# A zero price is an explicit value; only SQL NULL means that no legacy price exists.
		if row.local_sale_price is None:
			continue
		by_item.setdefault(row.item, []).append(row)

	for item, rows in by_item.items():
		doc = frappe.get_doc("Catalog Item", item)
		changed = False
		for row in rows:
			exists = any(
				price.price_type == price_type
				and price.business_point == row.business_point
				and float(price.minimum_quantity or 1) == 1
				for price in doc.prices
			)
			if exists:
				continue
			doc.append(
				"prices",
				{
					"price_type": price_type,
					"business_point": row.business_point,
					"uom": doc.stock_uom,
					"currency": "RUB",
					"rate": row.local_sale_price,
					"minimum_quantity": 1,
				},
			)
			changed = True
		if changed:
			doc.save(ignore_permissions=True)
