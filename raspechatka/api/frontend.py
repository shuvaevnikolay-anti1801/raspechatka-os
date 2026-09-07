import frappe
from frappe.utils import cint
from raspechatka.access import get_scope, require_access


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
	require_access("references.catalog", "read")

	limit_start = max(cint(limit_start), 0)
	limit_page_length = min(max(cint(limit_page_length), 1), 100)
	filters = {}

	if item_type:
		filters["item_type"] = item_type
	if catalog_group:
		filters["catalog_group"] = ["in", _catalog_group_branch(catalog_group)]
	if active not in (None, ""):
		filters["active"] = cint(active)

	if business_point:
		scope = get_scope()
		if not scope["global"] and business_point not in scope["points"]:
			frappe.throw("Точка недоступна", frappe.PermissionError)
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

	count_rows = frappe.get_all(
		"Catalog Item",
		fields=[{"COUNT": "name", "as": "total_count"}],
		filters=filters,
		or_filters=or_filters,
	)
	total_count = cint(count_rows[0].total_count) if count_rows else 0

	rows = frappe.get_all(
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
			"minimum_sale_price",
		],
		filters=filters,
		or_filters=or_filters,
		order_by="item_name asc",
		limit_start=limit_start,
		limit_page_length=limit_page_length + 1,
	)

	return {
		"items": rows[:limit_page_length],
		"total_count": total_count,
		"has_more": limit_start + limit_page_length < total_count,
	}


@frappe.whitelist()
def get_catalog_filters():
	require_access("references.catalog", "read")
	scope = get_scope()
	point_filters = {"active": 1} if scope["global"] else {"active": 1, "name": ["in", scope["points"] or ["__none__"]]}

	groups = frappe.get_all(
		"Catalog Group",
		filters={"active": 1},
		fields=["name", "group_name", "parent_catalog_group", "is_group"],
		order_by="group_name asc",
		limit_page_length=2000,
	)
	count_rows = frappe.get_all(
		"Catalog Item",
		filters={"active": 1},
		fields=["catalog_group", {"COUNT": "name", "as": "item_count"}],
		group_by="catalog_group",
		limit_page_length=2000,
	)
	counts = {
		row.catalog_group: cint(row.item_count)
		for row in count_rows
		if row.catalog_group
	}
	children = {}
	for group in groups:
		children.setdefault(group.parent_catalog_group or "", []).append(group.name)

	def branch_count(root):
		"""Count a group branch without recursion or duplicate traversal."""
		total = 0
		pending = [root]
		seen = set()
		while pending:
			name = pending.pop()
			if name in seen:
				continue
			seen.add(name)
			total += counts.get(name, 0)
			pending.extend(children.get(name, []))
		return total

	for group in groups:
		group["direct_item_count"] = counts.get(group.name, 0)
		group["item_count"] = branch_count(group.name)

	return {
		"groups": groups,
		"business_points": frappe.get_all(
			"Business Point",
			filters=point_filters,
			fields=["name", "point_name", "city"],
			order_by="point_name asc",
			limit_page_length=500,
		),
	}


def _catalog_group_branch(root):
	groups = frappe.get_all(
		"Catalog Group",
		filters={"active": 1},
		fields=["name", "parent_catalog_group"],
		limit_page_length=2000,
	)
	children = {}
	for group in groups:
		children.setdefault(group.parent_catalog_group or "", []).append(group.name)
	result = []
	pending = [root]
	seen = set()
	while pending:
		name = pending.pop()
		if name in seen:
			continue
		seen.add(name)
		result.append(name)
		pending.extend(children.get(name, []))
	return result


@frappe.whitelist(methods=["POST"])
def save_catalog_group(data):
	data = frappe.parse_json(data)
	require_access("references.catalog", "write" if data.get("name") else "create")
	group_name = (data.get("group_name") or "").strip()
	if not group_name:
		frappe.throw("Укажите название группы")

	doc = frappe.get_doc("Catalog Group", data["name"]) if data.get("name") else frappe.new_doc("Catalog Group")
	parent = data.get("parent_catalog_group") or None
	if parent:
		if parent == doc.name or (doc.name and parent in _catalog_group_branch(doc.name)):
			frappe.throw("Группу нельзя вложить саму в себя")
		if not frappe.db.exists("Catalog Group", parent):
			frappe.throw("Родительская группа не найдена")

	doc.group_name = group_name
	doc.parent_catalog_group = parent
	doc.description = data.get("description") or ""
	doc.active = cint(data.get("active", 1))
	doc.is_group = cint(data.get("is_group", 0))
	doc.save(ignore_permissions=True)
	if parent:
		frappe.db.set_value("Catalog Group", parent, "is_group", 1, update_modified=False)
	return {"name": doc.name}


@frappe.whitelist()
def get_catalog_item(name=None, item_type="Product"):
	require_access("references.catalog", "read")
	doc = frappe.get_doc("Catalog Item", name).as_dict(no_nulls=False) if name else {"item_type": item_type, "active": 1, "track_inventory": 1 if item_type == "Product" else 0, "stock_uom": "Штука", "valuation_method": "Moving Average", "tracking_method": "None", "vat_rate": "Без НДС", "tax_system": "По настройке точки", "receipt_subject": "Товар" if item_type == "Product" else "Услуга", "prices": [], "barcodes": []}
	scope = get_scope()
	point_filters = {"active": 1} if scope["global"] else {"active": 1, "name": ["in", scope["points"] or ["__none__"]]}
	warehouse_filters = {"active": 1} if scope["global"] else {"active": 1, "business_point": ["in", scope["points"] or ["__none__"]]}
	doc["assortments"] = frappe.get_all("Catalog Assortment", filters={"item": name, **({} if scope["global"] else {"business_point": ["in", scope["points"] or ["__none__"]]})}, fields=["name", "business_point", "enabled", "visible_in_pos", "local_sale_price", "valid_from", "valid_upto", "default_warehouse", "minimum_stock", "reorder_quantity", "notes"], order_by="business_point asc") if name else []
	options = {
		"groups": frappe.get_all("Catalog Group", filters={"active": 1, "is_group": 0}, fields=["name", "group_name"], order_by="group_name asc"),
		"units": frappe.get_all("Catalog Unit", filters={"active": 1}, fields=["name", "unit_name"], order_by="unit_name asc"),
		"suppliers": frappe.get_all("Catalog Supplier", filters=_supplier_filters(), fields=["name", "supplier_name"], order_by="supplier_name asc"),
		"price_types": frappe.get_all("Catalog Price Type", filters={"active": 1}, fields=["name", "price_type_name"], order_by="price_type_name asc"),
		"items": frappe.get_all("Catalog Item", filters={"active": 1, **({"name": ["!=", name]} if name else {})}, fields=["name", "item_name", "stock_uom"], order_by="item_name asc", limit_page_length=2000),
		"points": frappe.get_all("Business Point", filters=point_filters, fields=["name", "point_name"], order_by="point_name asc"),
		"warehouses": frappe.get_all("Catalog Warehouse", filters=warehouse_filters, fields=["name", "warehouse_name", "business_point"], order_by="warehouse_name asc"),
	}
	return {"doc": doc, "options": options}


@frappe.whitelist(methods=["POST"])
def save_catalog_item(data):
	data = frappe.parse_json(data)
	require_access("references.catalog", "write" if data.get("name") else "create")
	doc = frappe.get_doc("Catalog Item", data["name"]) if data.get("name") else frappe.new_doc("Catalog Item")
	if data.get("default_supplier") and not frappe.db.exists("Catalog Supplier", {"name": data.get("default_supplier"), **_supplier_filters()}):
		frappe.throw("Поставщик недоступен", frappe.PermissionError)
	allowed = ("item_code", "item_name", "item_type", "catalog_group", "stock_uom", "active", "description", "article", "external_code", "brand", "country_of_origin", "default_supplier", "weight", "volume", "color", "size", "minimum_sale_price", "prevent_discounts", "track_inventory", "valuation_method", "allow_negative_stock", "tracking_method", "shelf_life_days", "lead_time_days", "minimum_order_qty", "vat_rate", "tax_system", "receipt_subject")
	for fieldname in allowed:
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	child_tables = {
		"prices": ("price_type", "rate", "minimum_quantity", "valid_from", "valid_upto"),
		"barcodes": ("barcode", "barcode_type", "uom", "quantity"),
		"reorder_rules": ("warehouse", "minimum_stock", "reorder_quantity", "preferred_supplier"),
		"bundle_components": ("item", "quantity", "uom", "notes"),
		"packaging": ("package_name", "uom", "quantity", "barcode", "weight"),
		"analogues": ("item", "priority", "notes"),
		"attributes": ("attribute_name", "attribute_value"),
	}
	for table, fields in child_tables.items():
		if table in data:
			doc.set(table, [])
			for row in data.get(table) or []:
				doc.append(table, {key: row.get(key) for key in fields})
	doc.save(ignore_permissions=True)
	if "assortments" in data:
		_save_assortments(doc.name, data.get("assortments") or [])
	return {"name": doc.name}


def _supplier_filters():
	scope = get_scope()
	filters = {"active": 1}
	if not scope["global"]:
		allowed = frappe.get_all("Catalog Supplier", or_filters={"scope": "Network", "business_entity": scope["business_entity"] or "__none__"}, pluck="name")
		filters["name"] = ["in", allowed or ["__none__"]]
	return filters


def _save_assortments(item, rows):
	scope = get_scope()
	allowed_points = None if scope["global"] else set(scope["points"] or [])
	points = [row.get("business_point") for row in rows]
	if any(not point for point in points) or len(points) != len(set(points)):
		frappe.throw("Каждую точку в ассортименте можно указать только один раз")
	for row in rows:
		if allowed_points is not None and row.get("business_point") not in allowed_points:
			frappe.throw("Точка недоступна", frappe.PermissionError)
		if row.get("default_warehouse") and frappe.db.get_value("Catalog Warehouse", row.get("default_warehouse"), "business_point") != row.get("business_point"):
			frappe.throw("Склад должен относиться к выбранной точке")
	existing_filters = {"item": item, **({} if scope["global"] else {"business_point": ["in", list(allowed_points) or ["__none__"]]})}
	for name in frappe.get_all("Catalog Assortment", filters=existing_filters, pluck="name"):
		frappe.delete_doc("Catalog Assortment", name, ignore_permissions=True)
	for row in rows:
		doc = frappe.new_doc("Catalog Assortment")
		doc.item = item
		for fieldname in ("business_point", "enabled", "visible_in_pos", "local_sale_price", "valid_from", "valid_upto", "default_warehouse", "minimum_stock", "reorder_quantity", "notes"):
			doc.set(fieldname, row.get(fieldname))
		doc.insert(ignore_permissions=True)
