from __future__ import annotations

import frappe
from frappe.utils import flt, getdate, nowdate


@frappe.whitelist()
def get_bootstrap(workplace_code=None):
	"""Return the cashier, point rules and point-specific catalog for POS."""
	if frappe.session.user == "Guest":
		frappe.throw("Требуется авторизация", frappe.AuthenticationError)

	employee = _get_employee()
	allowed_points = _employee_points(employee)
	workplace = _get_workplace(workplace_code, allowed_points)
	point = frappe.get_doc("Business Point", workplace.business_point)

	return {
		"employee": {"id": employee.get("name"), "name": employee.get("employee_name") or frappe.session.user},
		"point": {"id": point.name, "name": point.point_name},
		"workplace": {"id": workplace.name, "name": workplace.workplace_name},
		"rules": {
			"allowDiscounts": bool(point.allow_discounts),
			"maxDiscountPercent": flt(point.max_discount_percent),
			"acceptsCash": bool(point.accepts_cash),
			"acceptsCard": bool(point.accepts_card),
			"acceptsQr": bool(point.accepts_qr),
		},
		"products": _get_products(point.name),
	}


def _get_employee():
	rows = frappe.get_all(
		"Employee",
		filters={"user": frappe.session.user, "active": 1},
		fields=["name", "employee_name"],
		limit_page_length=1,
	)
	if rows:
		return rows[0]
	if frappe.session.user == "Administrator":
		return frappe._dict(name="Administrator", employee_name="Администратор")
	frappe.throw("Для пользователя не создан активный сотрудник", frappe.PermissionError)


def _employee_points(employee):
	if employee.name == "Administrator":
		return frappe.get_all("Business Point", filters={"active": 1}, pluck="name")
	return frappe.get_all(
		"Employee Point Assignment",
		filters={"parent": employee.name, "parenttype": "Employee"},
		pluck="business_point",
	)


def _get_workplace(workplace_code, allowed_points):
	filters = {"active": 1, "business_point": ["in", allowed_points or ["__none__"]]}
	if workplace_code:
		filters["workplace_code"] = workplace_code
	rows = frappe.get_all(
		"POS Workplace",
		filters=filters,
		fields=["name", "workplace_name", "workplace_code", "business_point"],
		order_by="workplace_name asc",
		limit_page_length=2,
	)
	if not rows:
		frappe.throw("Для доступной точки не настроено рабочее место кассы")
	if not workplace_code and len(rows) > 1:
		frappe.throw("Укажите код рабочего места: пользователю доступно несколько касс")
	return rows[0]


def _get_products(point_name):
	today = getdate(nowdate())
	assortments = frappe.get_all(
		"Catalog Assortment",
		filters={"business_point": point_name, "enabled": 1, "visible_in_pos": 1},
		fields=["item", "local_sale_price", "valid_from", "valid_upto"],
		limit_page_length=5000,
	)
	assortments = [
		row for row in assortments
		if (not row.valid_from or getdate(row.valid_from) <= today)
		and (not row.valid_upto or getdate(row.valid_upto) >= today)
	]
	if not assortments:
		return []

	items = {
		row.name: row
		for row in frappe.get_all(
			"Catalog Item",
			filters={"name": ["in", [row.item for row in assortments]], "active": 1},
			fields=["name", "item_name", "item_code", "item_type", "catalog_group", "stock_uom"],
			limit_page_length=5000,
		)
	}
	group_names = {
		row.name: row.group_name
		for row in frappe.get_all(
			"Catalog Group",
			filters={"name": ["in", list({row.catalog_group for row in items.values() if row.catalog_group}) or ["__none__"]]},
			fields=["name", "group_name"],
			limit_page_length=1000,
		)
	}
	result = []
	for assortment in assortments:
		item = items.get(assortment.item)
		if not item:
			continue
		price = flt(assortment.local_sale_price) or _network_price(item.name)
		barcode = frappe.db.get_value(
			"Catalog Item Barcode",
			{"parent": item.name, "parenttype": "Catalog Item", "parentfield": "barcodes"},
			"barcode",
		)
		result.append({
			"id": item.name,
			"name": item.item_name,
			"sku": item.item_code,
			"category": group_names.get(item.catalog_group) or "Без группы",
			"type": {"Product": "product", "Service": "service", "Bundle": "bundle"}.get(item.item_type, "service"),
			"uom": item.stock_uom or "шт",
			"priceMinor": round(price * 100),
			"barcode": barcode,
			"stock": None,
		})
	return sorted(result, key=lambda row: (row["category"], row["name"]))


def _network_price(item_name):
	rows = frappe.get_all(
		"Catalog Item Price",
		filters={"parent": item_name, "parenttype": "Catalog Item", "parentfield": "prices"},
		fields=["rate", "minimum_quantity", "valid_from", "valid_upto", "idx"],
		order_by="minimum_quantity asc, idx asc",
		limit_page_length=100,
	)
	today = getdate(nowdate())
	for row in rows:
		if flt(row.minimum_quantity or 1) > 1:
			continue
		if row.valid_from and getdate(row.valid_from) > today:
			continue
		if row.valid_upto and getdate(row.valid_upto) < today:
			continue
		return flt(row.rate)
	return 0
