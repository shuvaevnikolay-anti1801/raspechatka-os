# ruff: noqa: RUF001
from __future__ import annotations

from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import add_days, flt, nowdate

from raspechatka.access import require_access
from raspechatka.api.warehouse import _supplier_scope_filters
from raspechatka.api.warehouse_reports import get_stock_balances


@frappe.whitelist()
def get_purchase_proposal(
	business_point=None,
	warehouse=None,
	catalog_group=None,
	search=None,
):
	require_access("page.warehouse.purchase_orders", "create")
	return _build_proposal(
		business_point=business_point,
		warehouse=warehouse,
		catalog_group=catalog_group,
		search=search,
		limit_page_length=0,
	)


@frappe.whitelist(methods=["POST"])
def create_purchase_order_drafts(
	business_point=None,
	warehouse=None,
	catalog_group=None,
	search=None,
):
	require_access("page.warehouse.purchase_orders", "create")
	warehouse_names = _proposal_warehouses(business_point, warehouse)
	_lock_warehouses(warehouse_names)
	proposal = _build_proposal(
		business_point=business_point,
		warehouse=warehouse,
		catalog_group=catalog_group,
		search=search,
		limit_page_length=0,
	)

	created = []
	for group in proposal["groups"]:
		doc = frappe.new_doc("Purchase Order")
		doc.update(
			{
				"order_date": nowdate(),
				"expected_date": group["expected_date"],
				"business_entity": group["business_entity"],
				"business_point": group["business_point"],
				"warehouse": group["warehouse"],
				"supplier": group["supplier"],
				"remarks": _("Автоматический черновик по рекомендации пополнения от {0}.").format(nowdate()),
			}
		)
		for row in group["items"]:
			doc.append(
				"items",
				{
					"item": row["item"],
					"uom": row["uom"],
					"quantity": row["quantity"],
					"rate": row["rate"],
				},
			)
		doc.flags.ignore_permissions = True
		doc.insert()
		created.append(
			{
				"name": doc.name,
				"supplier": group["supplier"],
				"supplier_name": group["supplier_name"],
				"warehouse": group["warehouse"],
				"warehouse_name": group["warehouse_name"],
				"items_count": len(group["items"]),
				"total_quantity": doc.total_quantity,
				"total_amount": doc.total_amount,
			}
		)

	return {
		"created": created,
		"created_count": len(created),
		"unresolved": proposal["unresolved"],
		"as_of": proposal["as_of"],
	}


def _build_proposal(business_point=None, warehouse=None, catalog_group=None, search=None):
	balances = get_stock_balances(
		as_of=nowdate(),
		business_point=business_point,
		warehouse=warehouse,
		catalog_group=catalog_group,
		search=search,
		limit_page_length=0,
	)
	rows = [row for row in balances["rows"] if flt(row.get("recommended_order_quantity")) > 0]
	warehouse_names = sorted({row["warehouse"] for row in rows})
	item_names = sorted({row["item"] for row in rows})
	draft_quantities = _draft_quantities(warehouse_names)
	items = _item_settings(item_names)
	suppliers = _allowed_suppliers()
	last_rates = _last_purchase_rates(item_names)

	groups = defaultdict(list)
	unresolved = []
	for row in rows:
		item = items.get(row["item"])
		quantity = max(
			flt(row["recommended_order_quantity"])
			- flt(draft_quantities.get((row["item"], row["warehouse"]))),
			0,
		)
		if quantity <= 0:
			continue
		supplier = item.default_supplier if item else None
		if not supplier:
			unresolved.append(_unresolved(row, quantity, "Не назначен основной поставщик"))
			continue
		if supplier not in suppliers:
			unresolved.append(_unresolved(row, quantity, "Основной поставщик неактивен или недоступен"))
			continue
		rate = flt(last_rates.get((row["item"], supplier)))
		rate_source = "Последняя приёмка"
		if rate <= 0:
			rate = flt(row.get("average_rate"))
			rate_source = "Текущая средняя себестоимость" if rate > 0 else "Не указана"
		groups[(row["warehouse"], supplier)].append(
			{
				"item": row["item"],
				"item_code": row.get("item_code"),
				"item_name": row.get("item_name"),
				"uom": row.get("uom"),
				"quantity": quantity,
				"rate": rate,
				"rate_source": rate_source,
				"lead_time_days": int(item.lead_time_days or 0) if item else 0,
			}
		)

	warehouse_rows = {
		row.name: row
		for row in frappe.get_all(
			"Catalog Warehouse",
			filters={"name": ["in", warehouse_names or ["__none__"]]},
			fields=["name", "warehouse_name", "business_point"],
			limit_page_length=0,
		)
	}
	point_names = {row.business_point for row in warehouse_rows.values()}
	points = {
		row.name: row
		for row in frappe.get_all(
			"Business Point",
			filters={"name": ["in", list(point_names) or ["__none__"]]},
			fields=["name", "business_entity"],
			limit_page_length=0,
		)
	}
	result_groups = []
	for (warehouse_name, supplier), group_items in sorted(groups.items()):
		warehouse_row = warehouse_rows[warehouse_name]
		point = points[warehouse_row.business_point]
		lead_time = max((row["lead_time_days"] for row in group_items), default=0)
		result_groups.append(
			{
				"warehouse": warehouse_name,
				"warehouse_name": warehouse_row.warehouse_name,
				"business_point": warehouse_row.business_point,
				"business_entity": point.business_entity,
				"supplier": supplier,
				"supplier_name": suppliers[supplier],
				"expected_date": str(add_days(nowdate(), lead_time)) if lead_time else None,
				"items": group_items,
				"items_count": len(group_items),
				"total_quantity": sum(row["quantity"] for row in group_items),
				"estimated_amount": sum(row["quantity"] * row["rate"] for row in group_items),
			}
		)

	return {
		"groups": result_groups,
		"groups_count": len(result_groups),
		"items_count": sum(group["items_count"] for group in result_groups),
		"total_quantity": sum(group["total_quantity"] for group in result_groups),
		"estimated_amount": sum(group["estimated_amount"] for group in result_groups),
		"unresolved": unresolved,
		"as_of": str(nowdate()),
	}


def _proposal_warehouses(business_point=None, warehouse=None):
	balances = get_stock_balances(
		as_of=nowdate(),
		business_point=business_point,
		warehouse=warehouse,
		limit_page_length=0,
	)
	return sorted({row["warehouse"] for row in balances["rows"]})


def _lock_warehouses(warehouses):
	for warehouse in sorted(warehouses):
		frappe.db.sql(
			"select name from `tabCatalog Warehouse` where name = %s for update",
			(warehouse,),
		)


def _draft_quantities(warehouses):
	orders = frappe.get_all(
		"Purchase Order",
		filters={"docstatus": 0, "warehouse": ["in", warehouses or ["__none__"]]},
		fields=["name", "warehouse"],
		limit_page_length=0,
	)
	warehouse_by_order = {row.name: row.warehouse for row in orders}
	result = {}
	for row in frappe.get_all(
		"Purchase Order Item",
		filters={"parent": ["in", list(warehouse_by_order) or ["__none__"]]},
		fields=["parent", "item", "quantity"],
		limit_page_length=0,
	):
		key = (row.item, warehouse_by_order[row.parent])
		result[key] = result.get(key, 0) + flt(row.quantity)
	return result


def _item_settings(items):
	result = {
		row.name: row
		for row in frappe.get_all(
			"Catalog Item",
			filters={"name": ["in", items or ["__none__"]]},
			fields=["name", "default_supplier", "lead_time_days"],
			limit_page_length=0,
		)
	}
	for relation in frappe.get_all(
		"Catalog Item Supplier",
		filters={
			"item": ["in", items or ["__none__"]],
			"is_primary": 1,
			"active": 1,
		},
		fields=["item", "supplier"],
		limit_page_length=0,
	):
		if relation.item in result and not result[relation.item].default_supplier:
			result[relation.item].default_supplier = relation.supplier
	return result


def _allowed_suppliers():
	return {
		row.name: row.supplier_name
		for row in frappe.get_all(
			"Catalog Supplier",
			filters=_supplier_scope_filters(),
			fields=["name", "supplier_name"],
			limit_page_length=0,
		)
	}


def _last_purchase_rates(items):
	if not items:
		return {}
	placeholders = ", ".join(["%s"] * len(items))
	rows = frappe.db.sql(
		f"""select receipt_item.item, receipt.supplier, receipt_item.rate
		from `tabStock Receipt Item` receipt_item
		inner join `tabStock Receipt` receipt on receipt.name = receipt_item.parent
		where receipt.docstatus = 1
			and receipt.receipt_type = 'Приёмка'
			and receipt_item.item in ({placeholders})
		order by receipt.posting_datetime desc, receipt_item.creation desc""",
		tuple(items),
		as_dict=True,
	)
	result = {}
	for row in rows:
		if row.supplier and flt(row.rate) > 0:
			result.setdefault((row.item, row.supplier), flt(row.rate))
	return result


def _unresolved(row, quantity, reason):
	return {
		"item": row["item"],
		"item_code": row.get("item_code"),
		"item_name": row.get("item_name"),
		"warehouse": row["warehouse"],
		"warehouse_name": row.get("warehouse_name"),
		"quantity": quantity,
		"reason": reason,
	}
