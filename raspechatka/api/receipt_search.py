from __future__ import annotations

import re

import frappe
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


@frappe.whitelist(allow_guest=True, methods=["POST"])
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
	status=None,
	receipt_type=None,
	limit=100,
):
	"""Search receipts server-side and always scope results to the POS business point."""
	connection = base_pos._authenticate(device_id, token)
	point = connection.business_point
	limit = min(max(cint(limit) or 100, 1), 200)
	filters = [
		["Sales Receipt", "business_point", "=", point],
		["Sales Receipt", "docstatus", "!=", 2],
	]

	if period == "current_shift":
		shift_name = _shift_name(point, shift_external_id)
		if not shift_name:
			return {"rows": []}
		filters.append(["Sales Receipt", "shift", "=", shift_name])
	else:
		start, end = _period_bounds(period, date_from, date_to)
		if start:
			filters.append(["Sales Receipt", "posting_datetime", ">=", start])
		if end:
			filters.append(["Sales Receipt", "posting_datetime", "<=", end])

	if cashier_id:
		filters.append(["Sales Receipt", "cashier", "=", cashier_id])
	if receipt_type in ("Sale", "Return"):
		filters.append(["Sales Receipt", "receipt_type", "=", receipt_type])
	if status in ("Draft", "Posted", "Cancelled"):
		filters.append(["Sales Receipt", "status", "=", status])
	if amount_min_minor not in (None, ""):
		filters.append(["Sales Receipt", "total_amount", ">=", flt(amount_min_minor) / 100])
	if amount_max_minor not in (None, ""):
		filters.append(["Sales Receipt", "total_amount", "<=", flt(amount_max_minor) / 100])

	candidates = _search_candidates(point, query)
	if candidates is not None:
		if not candidates:
			return {"rows": []}
		filters.append(["Sales Receipt", "name", "in", list(candidates)])

	if payment_channel in ("Cash", "Card", "QR"):
		payment_receipts = _payment_receipts(point, payment_channel)
		if not payment_receipts:
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
	if not rows:
		base_pos._touch(connection)
		return {"rows": []}

	clients = {
		row.name: row
		for row in frappe.get_all(
			"Client",
			filters={"name": ["in", [row.client for row in rows if row.client] or ["__none__"]]},
			fields=["name", "client_name", "phone"],
			limit_page_length=1000,
		)
	}
	cashiers = {
		row.name: row.employee_name
		for row in frappe.get_all(
			"Employee",
			filters={"name": ["in", [row.cashier for row in rows if row.cashier] or ["__none__"]]},
			fields=["name", "employee_name"],
			limit_page_length=1000,
		)
	}
	payments = {}
	for payment in frappe.get_all(
		"Sales Receipt Payment",
		filters={"parent": ["in", [row.name for row in rows]]},
		fields=["parent", "payment_channel"],
		limit_page_length=5000,
	):
		payments.setdefault(payment.parent, []).append(payment.payment_channel)

	result = []
	for row in rows:
		client = clients.get(row.client)
		channels = list(dict.fromkeys(payments.get(row.name, [])))
		result.append(
			{
				"id": row.name,
				"externalId": row.external_id,
				"receiptNumber": _fiscal_number(row.comment, row.name),
				"receiptType": row.receipt_type,
				"createdAt": str(row.posting_datetime),
				"customerName": client.client_name if client else "Розничный покупатель",
				"customerPhone": client.phone if client else None,
				"cashierName": cashiers.get(row.cashier) or row.cashier,
				"paymentLabel": " + ".join(channels) if channels else "—",
				"totalMinor": round(flt(row.total_amount) * 100),
				"discountMinor": round(flt(row.discount_amount) * 100),
				"reviewDiscountMinor": round(flt(row.review_discount_amount) * 100),
				"status": row.status,
			}
		)
	base_pos._touch(connection)
	return {"rows": result}
