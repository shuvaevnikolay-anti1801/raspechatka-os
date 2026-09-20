from __future__ import annotations

import re

import frappe
from raspechatka.access_contract import access_contract

from frappe.utils import add_days, cint, flt, getdate, today

from raspechatka.api import pos_device as base_pos


def _day_bounds(value):
	date_value = getdate(value)
	return f"{date_value} 00:00:00", f"{date_value} 23:59:59"


def _period_bounds(period, date_from=None, date_to=None):
	current = getdate(today())
	if period == "today":
		return _day_bounds(current)
	if period == "yesterday":
		return _day_bounds(add_days(current, -1))
	if period == "7d":
		start, _ = _day_bounds(add_days(current, -6))
		_, end = _day_bounds(current)
		return start, end
	if period == "30d":
		start, _ = _day_bounds(add_days(current, -29))
		_, end = _day_bounds(current)
		return start, end
	if period == "custom":
		start = _day_bounds(date_from)[0] if date_from else None
		end = _day_bounds(date_to)[1] if date_to else None
		return start, end
	return None, None


def _search_candidates(point, query):
	query = str(query or "").strip()
	if not query:
		return None
	value = f"%{query}%"
	candidates = set(
		frappe.get_all(
			"Sales Receipt",
			filters={"business_point": point, "docstatus": ["!=", 2]},
			or_filters={
				"name": ["like", value],
				"external_id": ["like", value],
				"comment": ["like", value],
			},
			pluck="name",
			limit_page_length=2000,
		)
	)
	clients = frappe.get_all(
		"Client",
		or_filters={"client_name": ["like", value], "phone": ["like", value]},
		pluck="name",
		limit_page_length=1000,
	)
	if clients:
		candidates.update(
			frappe.get_all(
				"Sales Receipt",
				filters={
					"business_point": point,
					"docstatus": ["!=", 2],
					"client": ["in", clients],
				},
				pluck="name",
				limit_page_length=2000,
			)
		)
	item_parents = frappe.get_all(
		"Sales Receipt Item",
		filters={"parenttype": "Sales Receipt"},
		or_filters={"item_name": ["like", value], "item_code": ["like", value]},
		pluck="parent",
		limit_page_length=2000,
	)
	if item_parents:
		candidates.update(
			frappe.get_all(
				"Sales Receipt",
				filters={
					"business_point": point,
					"docstatus": ["!=", 2],
					"name": ["in", item_parents],
				},
				pluck="name",
				limit_page_length=2000,
			)
		)
	return candidates


def _payment_receipts(point, payment_channel):
	parents = frappe.get_all(
		"Sales Receipt Payment",
		filters={"payment_channel": payment_channel},
		pluck="parent",
		limit_page_length=5000,
	)
	if not parents:
		return set()
	return set(
		frappe.get_all(
			"Sales Receipt",
			filters={
				"business_point": point,
				"docstatus": ["!=", 2],
				"name": ["in", parents],
			},
			pluck="name",
			limit_page_length=5000,
		)
	)


def _shift_name(point, shift_external_id):
	if not shift_external_id:
		return None
	return frappe.db.get_value(
		"Sales Shift",
		{"business_point": point, "external_id": shift_external_id},
		"name",
	)


def _fiscal_number(comment, fallback):
	match = re.search(r"Фискальный чек:\s*([^\s]+)", str(comment or ""))
	return match.group(1) if match else fallback


def _employee_name(employee_id):
	if not employee_id:
		return None
	return frappe.db.get_value("Employee", employee_id, "employee_name") or employee_id


def _client_info(client_id):
	if not client_id:
		return None
	return frappe.db.get_value("Client", client_id, ["client_name", "phone"], as_dict=True)


def _shift_external_id(shift_name):
	if not shift_name:
		return None
	return frappe.db.get_value("Sales Shift", shift_name, "external_id")


def _payment_method(channel):
	return {"Cash": "cash", "Card": "card", "QR": "qr"}.get(str(channel or ""))


def _summary(row, payments):
	client = _client_info(row.client)
	channels = list(dict.fromkeys(payment.payment_channel for payment in payments))
	return {
		"id": row.name,
		"externalId": row.external_id,
		"receiptNumber": _fiscal_number(row.comment, row.name),
		"receiptType": row.receipt_type,
		"createdAt": str(row.posting_datetime),
		"customerName": client.client_name if client else "Розничный покупатель",
		"customerPhone": client.phone if client else None,
		"cashierId": row.cashier,
		"cashierName": _employee_name(row.cashier),
		"shiftExternalId": _shift_external_id(row.shift),
		"paymentLabel": " + ".join(channels) if channels else "—",
		"totalMinor": round(flt(row.total_amount) * 100),
		"discountMinor": round(flt(row.discount_amount) * 100),
		"reviewDiscountMinor": round(flt(row.review_discount_amount) * 100),
		"status": row.status,
	}


@frappe.whitelist(allow_guest=True, methods=["POST"])
@access_contract(auth="pos_token", action="read", scope="pos_point")
def search_receipts(
	device_id,
	token,
	query=None,
	period="current_shift",
	shift_external_id=None,
	date_from=None,
	date_to=None,
	cashier_id=None,
	amount_min_minor=None,
	amount_max_minor=None,
	payment_channel=None,
	receipt_type=None,
	limit=100,
):
	"""Search receipts and always scope them to the authenticated POS business point."""
	connection = base_pos._authenticate(device_id, token)
	point = connection.business_point
	if cashier_id:
		base_pos._selected_employee(base_pos._point_employees(point), cashier_id)
	limit = min(max(cint(limit) or 100, 1), 200)
	filters = [
		["Sales Receipt", "business_point", "=", point],
		["Sales Receipt", "docstatus", "!=", 2],
	]

	if period == "current_shift":
		shift_name = _shift_name(point, shift_external_id)
		if not shift_name:
			base_pos._touch(connection)
			return {"rows": []}
		filters.append(["Sales Receipt", "shift", "=", shift_name])
	else:
		start_at, end_at = _period_bounds(period, date_from, date_to)
		if start_at:
			filters.append(["Sales Receipt", "posting_datetime", ">=", start_at])
		if end_at:
			filters.append(["Sales Receipt", "posting_datetime", "<=", end_at])

	if cashier_id:
		filters.append(["Sales Receipt", "cashier", "=", cashier_id])
	if receipt_type in ("Sale", "Return"):
		filters.append(["Sales Receipt", "receipt_type", "=", receipt_type])
	if amount_min_minor not in (None, ""):
		filters.append(["Sales Receipt", "total_amount", ">=", flt(amount_min_minor) / 100])
	if amount_max_minor not in (None, ""):
		filters.append(["Sales Receipt", "total_amount", "<=", flt(amount_max_minor) / 100])

	candidates = _search_candidates(point, query)
	if candidates is not None:
		if not candidates:
			base_pos._touch(connection)
			return {"rows": []}
		filters.append(["Sales Receipt", "name", "in", list(candidates)])

	if payment_channel in ("Cash", "Noncash"):
		if payment_channel == "Noncash":
			parents = frappe.get_all(
				"Sales Receipt Payment",
				filters={"payment_channel": ["in", ["Card", "QR"]]},
				pluck="parent",
				limit_page_length=5000,
			)
			payment_receipts = set(
				frappe.get_all(
					"Sales Receipt",
					filters={
						"business_point": point,
						"docstatus": ["!=", 2],
						"name": ["in", parents or ["__none__"]],
					},
					pluck="name",
					limit_page_length=5000,
				)
			)
		else:
			payment_receipts = _payment_receipts(point, "Cash")
		if not payment_receipts:
			base_pos._touch(connection)
			return {"rows": []}
		filters.append(["Sales Receipt", "name", "in", list(payment_receipts)])

	rows = frappe.get_all(
		"Sales Receipt",
		filters=filters,
		fields=[
			"name",
			"external_id",
			"receipt_type",
			"posting_datetime",
			"shift",
			"client",
			"cashier",
			"total_amount",
			"discount_amount",
			"review_discount_amount",
			"comment",
			"status",
		],
		order_by="posting_datetime desc",
		limit_page_length=limit,
	)
	names = [row.name for row in rows]
	payments_by_parent = {}
	for payment in frappe.get_all(
		"Sales Receipt Payment",
		filters={"parent": ["in", names or ["__none__"]]},
		fields=["parent", "payment_channel", "amount", "external_payment_id"],
		limit_page_length=5000,
	):
		payments_by_parent.setdefault(payment.parent, []).append(payment)

	result = [_summary(row, payments_by_parent.get(row.name, [])) for row in rows]
	base_pos._touch(connection)
	return {"rows": result}


@frappe.whitelist(allow_guest=True, methods=["POST"])
@access_contract(auth="pos_token", action="read", scope="pos_point")
def get_receipt(device_id, token, receipt_id):
	"""Return one full receipt, point-scoped to the authenticated POS connection."""
	connection = base_pos._authenticate(device_id, token)
	point = connection.business_point
	row = frappe.get_all(
		"Sales Receipt",
		filters={"name": receipt_id, "business_point": point, "docstatus": ["!=", 2]},
		fields=[
			"name",
			"external_id",
			"receipt_type",
			"posting_datetime",
			"shift",
			"client",
			"cashier",
			"original_receipt",
			"total_amount",
			"discount_amount",
			"review_discount_amount",
			"comment",
			"status",
		],
		limit_page_length=1,
	)
	if not row:
		frappe.throw("Чек не найден или относится к другой точке", frappe.PermissionError)
	receipt = row[0]
	payments = frappe.get_all(
		"Sales Receipt Payment",
		filters={"parent": receipt.name},
		fields=["payment_channel", "amount", "external_payment_id"],
		order_by="idx",
		limit_page_length=100,
	)

	returned_by_item = {}
	if receipt.receipt_type == "Sale":
		return_names = frappe.get_all(
			"Sales Receipt",
			filters={
				"business_point": point,
				"receipt_type": "Return",
				"original_receipt": receipt.name,
				"docstatus": ["!=", 2],
			},
			pluck="name",
			limit_page_length=1000,
		)
		if return_names:
			for item in frappe.get_all(
				"Sales Receipt Item",
				filters={"parent": ["in", return_names]},
				fields=["item", "quantity"],
				limit_page_length=5000,
			):
				returned_by_item[item.item] = returned_by_item.get(item.item, 0) + flt(item.quantity)

	lines = []
	for item in frappe.get_all(
		"Sales Receipt Item",
		filters={"parent": receipt.name},
		fields=["item", "item_name", "quantity", "unit_price", "discount_percent", "discount_amount"],
		order_by="idx",
		limit_page_length=1000,
	):
		gross_minor = round(flt(item.quantity) * flt(item.unit_price) * 100)
		discount_minor = round(flt(item.discount_amount) * 100)
		lines.append(
			{
				"productId": item.item,
				"name": item.item_name or item.item,
				"quantity": flt(item.quantity),
				"unitPriceMinor": round(flt(item.unit_price) * 100),
				"discountPercent": flt(item.discount_percent),
				"lineTotalMinor": max(0, gross_minor - discount_minor),
				"returnedQuantity": returned_by_item.get(item.item, 0),
			}
		)

	result = _summary(receipt, payments)
	result.update(
		{
			"originalReceiptId": receipt.original_receipt,
			"lines": lines,
			"payments": [
				{
					"method": _payment_method(payment.payment_channel),
					"channel": payment.payment_channel,
					"amountMinor": round(flt(payment.amount) * 100),
					"transactionId": payment.external_payment_id,
				}
				for payment in payments
			],
		}
	)
	base_pos._touch(connection)
	return result
