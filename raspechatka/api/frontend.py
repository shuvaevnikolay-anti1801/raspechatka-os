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
		or_filters = {"item_name": ["like", value]}

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
			"item_name",
			"item_type",
			"catalog_group",
			"stock_uom",
			"active",
			"variant_of",
			"has_variants",
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
def get_catalog_filters(include_archived=0):
	require_access("references.catalog", "read")
	scope = get_scope()
	point_filters = {"active": 1} if scope["global"] else {"active": 1, "name": ["in", scope["points"] or ["__none__"]]}

	groups = frappe.get_all(
		"Catalog Group",
		filters={} if cint(include_archived) else {"active": 1},
		fields=["name", "group_name", "parent_catalog_group", "is_group", "active"],
		order_by="group_name asc",
		limit_page_length=2000,
	)
	count_rows = frappe.get_all(
		"Catalog Item",
		filters={} if cint(include_archived) else {"active": 1},
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


def _catalog_group_branch(root, active_only=True):
	groups = frappe.get_all(
		"Catalog Group",
		filters={"active": 1} if active_only else {},
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
		if not frappe.db.get_value("Catalog Group", parent, "active"):
			frappe.throw("Нельзя переместить группу в архивную группу")

	doc.group_name = group_name
	doc.parent_catalog_group = parent
	doc.save(ignore_permissions=True)
	_refresh_group_flags()
	return {"name": doc.name}


def _refresh_group_flags():
	parents = set(
		row.parent_catalog_group
		for row in frappe.get_all("Catalog Group", fields=["parent_catalog_group"])
		if row.parent_catalog_group
	)
	for group in frappe.get_all("Catalog Group", pluck="name"):
		frappe.db.set_value("Catalog Group", group, "is_group", group in parents, update_modified=False)


@frappe.whitelist()
def get_catalog_item(name=None, item_type="Product"):
	require_access("references.catalog", "read")
	scope = get_scope()
	point_filters = {"active": 1} if scope["global"] else {"active": 1, "name": ["in", scope["points"] or ["__none__"]]}
	warehouse_filters = {"active": 1} if scope["global"] else {"active": 1, "business_point": ["in", scope["points"] or ["__none__"]]}
	points = frappe.get_all(
		"Business Point",
		filters=point_filters,
		fields=["name", "point_name"],
		order_by="point_name asc",
	)
	warehouses = frappe.get_all(
		"Catalog Warehouse",
		filters=warehouse_filters,
		fields=["name", "warehouse_name", "business_point"],
		order_by="warehouse_name asc",
	)
	if name:
		doc = frappe.get_doc("Catalog Item", name).as_dict(no_nulls=False)
		doc["assortments"] = frappe.get_all(
			"Catalog Assortment",
			filters={
				"item": name,
				**({} if scope["global"] else {"business_point": ["in", scope["points"] or ["__none__"]]}),
			},
			fields=[
				"name",
				"business_point",
				"enabled",
				"visible_in_pos",
				"default_warehouse",
				"minimum_stock",
				"reorder_quantity",
				"notes",
			],
			order_by="business_point asc",
		)
	else:
		default_warehouses = {}
		for warehouse in warehouses:
			default_warehouses.setdefault(warehouse.business_point, warehouse.name)
		doc = {
			"item_type": item_type,
			"active": 1,
			"stock_uom": "шт",
			"prevent_discounts": 0,
			"vat_rate": "Без НДС",
			"tax_system": "По настройке точки",
			"receipt_subject": "Услуга" if item_type == "Service" else "Товар",
			"prices": [],
			"bundle_components": [],
			"variant_values": [],
			"assortments": [
				{
					"business_point": point.name,
					"enabled": 1,
					"visible_in_pos": 1,
					"default_warehouse": default_warehouses.get(point.name),
					"minimum_stock": 0,
					"reorder_quantity": 0,
				}
				for point in points
			],
		}
	options = {
		"groups": frappe.get_all(
			"Catalog Group",
			filters={"active": 1},
			fields=["name", "group_name", "parent_catalog_group"],
			order_by="group_name asc",
		),
		"units": frappe.get_all(
			"Catalog Unit",
			filters={"active": 1, "name": ["in", ["шт", "мес"]]},
			fields=["name", "unit_name"],
			order_by="unit_name asc",
		),
		"suppliers": frappe.get_all("Catalog Supplier", filters=_supplier_filters(), fields=["name", "supplier_name"], order_by="supplier_name asc"),
		"price_types": frappe.get_all("Catalog Price Type", filters={"active": 1}, fields=["name", "price_type_name"], order_by="price_type_name asc"),
		"items": frappe.get_all(
			"Catalog Item",
			filters={"active": 1, **({"name": ["!=", name]} if name else {})},
			fields=["name", "item_name", "item_type", "stock_uom", "catalog_group", "default_supplier", "variant_of"],
			order_by="item_name asc",
			limit_page_length=2000,
		),
		"variant_parents": frappe.get_all(
			"Catalog Item",
			filters={"active": 1, "item_type": "Product", **({"name": ["!=", name]} if name else {})},
			fields=["name", "item_name", "stock_uom", "catalog_group", "default_supplier"],
			order_by="item_name asc",
			limit_page_length=2000,
		),
		"points": points,
		"warehouses": warehouses,
	}
	return {"doc": doc, "options": options}


@frappe.whitelist(methods=["POST"])
def save_catalog_item(data):
	data = frappe.parse_json(data)
	require_access("references.catalog", "write" if data.get("name") else "create")
	doc = frappe.get_doc("Catalog Item", data["name"]) if data.get("name") else frappe.new_doc("Catalog Item")
	if data.get("default_supplier") and not frappe.db.exists("Catalog Supplier", {"name": data.get("default_supplier"), **_supplier_filters()}):
		frappe.throw("Поставщик недоступен", frappe.PermissionError)
	allowed = (
		"item_name",
		"item_type",
		"catalog_group",
		"stock_uom",
		"default_supplier",
		"prevent_discounts",
		"variant_of",
	)
	for fieldname in allowed:
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	child_tables = {
		"prices": ("price_type", "business_point", "uom", "currency", "rate", "minimum_quantity", "valid_from", "valid_upto"),
		"bundle_components": ("item", "quantity", "uom", "notes"),
		"variant_values": ("attribute_name", "attribute_value"),
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



def _archive_values(active, reason=None, batch_id=None):
	from frappe.utils import now_datetime

	return {
		"active": 1 if active else 0,
		"archived_at": None if active else now_datetime(),
		"archived_by": None if active else frappe.session.user,
		"archive_reason": None if active else (reason or "").strip() or None,
		"archive_batch_id": None if active else batch_id,
	}


@frappe.whitelist(methods=["POST"])
def archive_catalog_item(name, reason=None):
	"""Archive an item without breaking links from historical documents."""
	require_access("references.catalog", "write")
	if not frappe.db.exists("Catalog Item", name):
		frappe.throw("Позиция каталога не найдена")
	batch_id = frappe.generate_hash(length=20)
	item = frappe.db.get_value("Catalog Item", name, ["item_type", "variant_of"], as_dict=True)
	affected_items = {name}
	if item.item_type == "Product":
		affected_items.update(
			frappe.get_all("Catalog Item", filters={"variant_of": name, "active": 1}, pluck="name")
		)
	for affected in affected_items:
		frappe.db.set_value("Catalog Item", affected, _archive_values(False, reason, batch_id))

	# Bundles that depend on an archived component cannot remain sellable.
	dependent_bundles = frappe.get_all(
		"Catalog Bundle Component",
		filters={"item": ["in", list(affected_items)]},
		pluck="parent",
	)
	for bundle in set(dependent_bundles):
		if frappe.db.get_value("Catalog Item", bundle, "active"):
			frappe.db.set_value("Catalog Item", bundle, _archive_values(False, "Компонент комплекта перенесён в архив", batch_id))
	_refresh_variant_flag(item.variant_of or name)
	return {"name": name, "active": 0, "archive_batch_id": batch_id}


@frappe.whitelist(methods=["POST"])
def restore_catalog_item(name):
	"""Restore an item only when all of its dependencies are active."""
	require_access("references.catalog", "write")
	doc = frappe.get_doc("Catalog Item", name)
	if doc.catalog_group and not frappe.db.get_value("Catalog Group", doc.catalog_group, "active"):
		frappe.throw("Сначала восстановите группу этой позиции")
	for row in doc.bundle_components:
		if not frappe.db.get_value("Catalog Item", row.item, "active"):
			frappe.throw("Сначала восстановите все компоненты комплекта")
	frappe.db.set_value("Catalog Item", name, _archive_values(True))
	if doc.item_type == "Product" and doc.archive_batch_id:
		for variant in frappe.get_all(
			"Catalog Item",
			filters={"variant_of": name, "archive_batch_id": doc.archive_batch_id},
			pluck="name",
		):
			frappe.db.set_value("Catalog Item", variant, _archive_values(True))
	_refresh_variant_flag(doc.variant_of or name)
	return {"name": name, "active": 1}


def _refresh_variant_flag(parent):
	if not parent or not frappe.db.exists("Catalog Item", parent):
		return
	has_variants = bool(frappe.db.exists("Catalog Item", {"variant_of": parent, "active": 1}))
	frappe.db.set_value("Catalog Item", parent, "has_variants", has_variants, update_modified=False)


@frappe.whitelist(methods=["POST"])
def archive_catalog_group(name, reason=None):
	"""Atomically archive a group branch and every item inside it."""
	require_access("references.catalog", "write")
	if not frappe.db.exists("Catalog Group", name):
		frappe.throw("Группа каталога не найдена")
	batch_id = frappe.generate_hash(length=20)
	groups = _catalog_group_branch(name, active_only=False)
	for group in groups:
		frappe.db.set_value("Catalog Group", group, _archive_values(False, reason, batch_id))
	items = frappe.get_all("Catalog Item", filters={"catalog_group": ["in", groups]}, pluck="name")
	products = frappe.get_all(
		"Catalog Item",
		filters={"name": ["in", items or ["__none__"]], "item_type": "Product"},
		pluck="name",
	)
	if products:
		items.extend(
			frappe.get_all(
				"Catalog Item",
				filters={"variant_of": ["in", products], "active": 1},
				pluck="name",
			)
		)
	items = list(dict.fromkeys(items))
	for item in items:
		frappe.db.set_value("Catalog Item", item, _archive_values(False, reason, batch_id))

	dependent_bundles = frappe.get_all(
		"Catalog Bundle Component",
		filters={"item": ["in", items]},
		pluck="parent",
	)
	for bundle in set(dependent_bundles) - set(items):
		if frappe.db.get_value("Catalog Item", bundle, "active"):
			frappe.db.set_value("Catalog Item", bundle, _archive_values(False, "Компонент комплекта перенесён в архив", batch_id))
	return {"name": name, "active": 0, "groups": len(groups), "items": len(items), "archive_batch_id": batch_id}


@frappe.whitelist(methods=["POST"])
def restore_catalog_group(name):
	"""Restore only records archived by the same cascading operation."""
	require_access("references.catalog", "write")
	doc = frappe.get_doc("Catalog Group", name)
	if doc.parent_catalog_group and not frappe.db.get_value("Catalog Group", doc.parent_catalog_group, "active"):
		frappe.throw("Сначала восстановите родительскую группу")
	batch_id = doc.archive_batch_id
	frappe.db.set_value("Catalog Group", name, _archive_values(True))
	if batch_id:
		for group in frappe.get_all("Catalog Group", filters={"archive_batch_id": batch_id}, pluck="name"):
			frappe.db.set_value("Catalog Group", group, _archive_values(True))
		batch_items = frappe.get_all(
			"Catalog Item",
			filters={"archive_batch_id": batch_id},
			fields=["name", "item_type"],
		)
		for item in batch_items:
			if item.item_type != "Bundle":
				frappe.db.set_value("Catalog Item", item.name, _archive_values(True))
		for item in batch_items:
			if item.item_type != "Bundle":
				continue
			components = frappe.get_all("Catalog Bundle Component", filters={"parent": item.name}, pluck="item")
			if all(frappe.db.get_value("Catalog Item", component, "active") for component in components):
				frappe.db.set_value("Catalog Item", item.name, _archive_values(True))
		for item in batch_items:
			if item.item_type == "Product":
				_refresh_variant_flag(item.name)
	return {"name": name, "active": 1}



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
	existing_filters = {
		"item": item,
		**({} if scope["global"] else {"business_point": ["in", list(allowed_points) or ["__none__"]]}),
	}
	existing = {
		row.business_point: row.name
		for row in frappe.get_all(
			"Catalog Assortment",
			filters=existing_filters,
			fields=["name", "business_point"],
		)
	}
	submitted_points = set(points)
	for point, name in existing.items():
		if point not in submitted_points:
			frappe.db.set_value(
				"Catalog Assortment",
				name,
				{"enabled": 0, "visible_in_pos": 0},
			)
	for row in rows:
		name = existing.get(row.get("business_point"))
		doc = frappe.get_doc("Catalog Assortment", name) if name else frappe.new_doc("Catalog Assortment")
		if not name:
			doc.item = item
		for fieldname in (
			"business_point",
			"enabled",
			"visible_in_pos",
			"default_warehouse",
			"minimum_stock",
			"reorder_quantity",
			"notes",
		):
			doc.set(fieldname, row.get(fieldname))
		doc.save(ignore_permissions=True)
