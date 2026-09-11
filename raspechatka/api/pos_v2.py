from __future__ import annotations

import re

import frappe
from frappe import _
from frappe.utils import cint, flt, now_datetime

from raspechatka.api import pos as legacy_pos
from raspechatka.api import pos_device as base_pos
from raspechatka.api import sales as sales_api
from raspechatka.sales import log_cashier_action, update_shift_totals


def _point_pos_groups(point_name):
	selected = set(
		frappe.get_all(
			"Business Point POS Group",
			filters={"parent": point_name, "parenttype": "Business Point"},
			pluck="catalog_group",
			limit_page_length=1000,
		)
	)
	if not selected:
		return set()

	allowed = set(selected)
	frontier = set(selected)
	while frontier:
		children = set(
			frappe.get_all(
				"Catalog Group",
				filters={"parent_catalog_group": ["in", list(frontier)], "active": 1},
				pluck="name",
				limit_page_length=5000,
			)
		)
		children -= allowed
		if not children:
			break
		allowed |= children
		frontier = children
	return allowed


def _products(point_name):
	products = legacy_pos._get_products(point_name)
	allowed_groups = _point_pos_groups(point_name)
	if not allowed_groups or not products:
		return products
	item_groups = {
		row.name: row.catalog_group
		for row in frappe.get_all(
			"Catalog Item",
			filters={"name": ["in", [row["id"] for row in products]]},
			fields=["name", "catalog_group"],
			limit_page_length=5000,
		)
	}
	return [row for row in products if item_groups.get(row["id"]) in allowed_groups]


def _customers():
	rows = base_pos._customers()
	if not rows:
		return rows
	club = {
		row.name: row.club_status
		for row in frappe.get_all(
			"Client",
			filters={"name": ["in", [row["id"] for row in rows]]},
			fields=["name", "club_status"],
			limit_page_length=10000,
		)
	}
	for row in rows:
		status = club.get(row["id"]) or ""
		row["clubStatus"] = status
		row["isClubMember"] = status == "Активен"
		if not row["isClubMember"]:
			row["discountPercent"] = 0
	return rows


def _rules(point):
	rules = base_pos._rules(point)
	rules["reviewDiscountPerReviewMinor"] = max(0, round(flt(point.review_discount_per_review) * 100))
	return rules


@frappe.whitelist(allow_guest=True, methods=["POST"])
def get_bootstrap(device_id, token, cashier_id=None):
	"""Point-scoped POS bootstrap with point catalog groups and club metadata."""
	connection = base_pos._authenticate(device_id, token)
	try:
		point = frappe.get_doc("Business Point", connection.business_point)
		if not cint(point.active):
			frappe.throw(_("Точка продаж отключена"))
		workplace = base_pos._workplace(point.name)
		employees = base_pos._point_employees(point.name)
		selected = base_pos._selected_employee(employees, cashier_id)
		workplace_data_employee = frappe._dict(
			name=selected["id"] if selected else "__none__",
			employee_name=selected["name"] if selected else "",
		)
		result = {
			"point": {"id": point.name, "name": point.point_name},
			"workplace": {"id": workplace.name, "name": workplace.workplace_name},
			"employee": selected,
			"employees": employees,
			"rules": _rules(point),
			"products": _products(point.name),
			"customers": _customers(),
			"workplaceData": legacy_pos._get_workplace_data(workplace_data_employee, point, workplace),
		}
		base_pos._touch(connection)
		return result
	except Exception as exc:
		base_pos._touch(connection, exc)
		raise


def _allocate_final_amounts(lines, total_minor):
	raw = []
	gross = []
	for row in lines:
		quantity = flt(row.get("quantity"))
		unit_price_minor = int(round(flt(row.get("unitPriceMinor"))))
		gross_minor = max(0, round(quantity * unit_price_minor))
		discount = min(max(flt(row.get("discountPercent")), 0), 100)
		net_minor = max(0, round(gross_minor * (1 - discount / 100)))
		gross.append(gross_minor)
		raw.append(net_minor)
	raw_total = sum(raw)
	if raw_total <= 0:
		frappe.throw(_("Сумма позиций чека должна быть больше нуля"))
	if total_minor < 0 or total_minor > sum(gross):
		frappe.throw(_("Некорректная итоговая сумма чека"))
	allocated = []
	used = 0
	for index, value in enumerate(raw):
		amount = total_minor - used if index == len(raw) - 1 else round(total_minor * value / raw_total)
		allocated.append(amount)
		used += amount
	return gross, raw, allocated


def _review_breakdown(payload, connection, raw_total, paid_total):
	receipt_discount = max(0, raw_total - paid_total)
	if receipt_discount <= 0:
		return 0, 0, 0
	club_percent = 0.0
	client = str(payload.get("customerId") or "").strip()
	if client:
		club = frappe.db.get_value("Client", client, ["club_status", "discount_percent"], as_dict=True)
		if club and club.club_status == "Активен":
			club_percent = flt(club.discount_percent)
	club_discount = raw_total - round(raw_total * (1 - min(max(club_percent, 0), 100) / 100))
	remaining = max(0, receipt_discount - club_discount)
	per_review = max(
		0,
		round(
			flt(frappe.db.get_value("Business Point", connection.business_point, "review_discount_per_review"))
			* 100
		),
	)
	if not per_review or not remaining:
		return 0, 0, receipt_discount
	review_count = max(0, int(round(remaining / per_review)))
	review_discount = min(receipt_discount, review_count * per_review)
	other_discount = max(0, receipt_discount - review_discount)
	return review_count, review_discount, other_discount


def _sale_receipt(payload, cashier_id, connection):
	lines = payload.get("lines") or []
	payments_payload = payload.get("payments") or []
	paid_total = sum(int(round(flt(payment.get("amountMinor")))) for payment in payments_payload)
	gross, raw, allocated = _allocate_final_amounts(lines, paid_total)
	review_count, review_discount, receipt_other_discount = _review_breakdown(
		payload, connection, sum(raw), paid_total
	)
	line_discount = sum(gross) - sum(raw)

	items = []
	for index, row in enumerate(lines):
		item = str(row.get("productId") or "")
		if item.startswith("free-"):
			item = legacy_pos._resolve_legacy_pos_item(row)
		items.append(
			{
				"item": item,
				"quantity": flt(row.get("quantity")),
				"uom": frappe.db.get_value("Catalog Item", item, "stock_uom"),
				"unit_price": flt(row.get("unitPriceMinor")) / 100,
				"discount_amount": max(0, gross[index] - allocated[index]) / 100,
			}
		)
	payments = []
	for payment in payments_payload:
		channel = base_pos._payment_channel(payment.get("method"))
		if not channel:
			frappe.throw(_("Неизвестный способ оплаты {0}").format(payment.get("method")))
		payments.append(
			{
				"payment_channel": channel,
				"amount": flt(payment.get("amountMinor")) / 100,
				"external_payment_id": payment.get("transactionId"),
			}
		)
	return {
		"external_id": payload.get("id"),
		"receipt_type": "Sale",
		"shift_external_id": payload.get("shiftId"),
		"posting_datetime": payload.get("createdAt"),
		"cashier": cashier_id,
		"client": payload.get("customerId"),
		"comment": f"Фискальный чек: {payload.get('fiscalNumber')}" if payload.get("fiscalNumber") else None,
		"review_discount_amount": review_discount / 100,
		"other_discount_amount": (receipt_other_discount + line_discount) / 100,
		"items": items,
		"payments": payments,
	}, review_count


@frappe.whitelist(allow_guest=True, methods=["POST"])
def push_events(device_id, token, cashier_id=None, events=None, app_version=None):
	"""POS outbox ingestion with correct receipt-level discount allocation."""
	connection = base_pos._authenticate(device_id, token)
	employees = base_pos._point_employees(connection.business_point)
	selected = base_pos._selected_employee(employees, cashier_id)
	if not selected:
		frappe.throw(_("Перед синхронизацией выберите сотрудника точки"))
	events = frappe.parse_json(events) if isinstance(events, str) else (events or [])
	if not isinstance(events, list):
		frappe.throw(_("Ожидается список событий"))
	if len(events) > 100:
		frappe.throw(_("За один запрос можно передать не более 100 событий"))
	accepted = []
	try:
		for event in events:
			event_id = str(event.get("id") or "").strip()
			event_type = str(event.get("eventType") or "").strip()
			payload = event.get("payload") or {}
			if not event_id or not event_type:
				frappe.throw(_("В событии отсутствует id или eventType"))
			stats = {"created": 0, "duplicates": 0, "errors": []}
			if event_type == "shift.opened":
				sales_api._ingest_shift(base_pos._shift(payload, selected["id"]), connection, stats)
			elif event_type == "shift.closed":
				sales_api._ingest_shift(base_pos._shift(payload, selected["id"], True), connection, stats, update_existing=True)
			elif event_type == "sale.completed":
				receipt, review_count = _sale_receipt(payload, selected["id"], connection)
				sales_api._ingest_receipt(receipt, connection, stats)
				if review_count:
					name = frappe.db.get_value("Sales Receipt", {"external_id": payload.get("id")}, "name")
					if name:
						doc = frappe.get_doc("Sales Receipt", name)
						log_cashier_action(
							doc,
							"REVIEW_RECEIVED",
							external_id=f"{payload.get('id')}:reviews",
							metric_value=review_count,
						)
						update_shift_totals(doc.shift)
			elif event_type == "sale.returned":
				sales_api._ingest_receipt(base_pos._return_receipt(payload, selected["id"]), connection, stats)
			elif event_type == "cash.deposited":
				sales_api._ingest_cash(base_pos._cash(payload, selected["id"], "Deposit"), connection, stats)
			elif event_type == "cash.withdrawn":
				sales_api._ingest_cash(base_pos._cash(payload, selected["id"], "Withdrawal"), connection, stats)
			elif event_type in ("order.created", "order.updated"):
				base_pos._ingest_order(event_type, event_id, connection, payload)
			else:
				continue
			accepted.append(event_id)
		connection.app_version = app_version or connection.app_version
		connection.last_sync_at = now_datetime()
		base_pos._touch(connection)
		return {"accepted": accepted}
	except Exception as exc:
		base_pos._touch(connection, exc)
		raise


def _fiscal_number(comment, fallback):
	match = re.search(r"Фискальный чек:\s*([^\s]+)", str(comment or ""))
	return match.group(1) if match else fallback


@frappe.whitelist(allow_guest=True, methods=["POST"])
def search_receipts(device_id, token, query=None, limit=100):
	"""Search sale receipts across the whole current business point, never another point."""
	connection = base_pos._authenticate(device_id, token)
	point = connection.business_point
	query = str(query or "").strip()
	limit = min(max(cint(limit) or 100, 1), 200)
	base_filters = {"business_point": point, "receipt_type": "Sale", "docstatus": ["!=", 2]}

	if query:
		value = f"%{query}%"
		candidates = set(
			frappe.get_all(
				"Sales Receipt",
				filters=base_filters,
				or_filters={"name": ["like", value], "external_id": ["like", value], "comment": ["like", value]},
				pluck="name",
				limit_page_length=1000,
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
					filters={**base_filters, "client": ["in", clients]},
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
					filters={**base_filters, "name": ["in", item_parents]},
					pluck="name",
					limit_page_length=2000,
				)
			)
		if not candidates:
			return {"rows": []}
		filters = {**base_filters, "name": ["in", list(candidates)]}
	else:
		filters = base_filters

	rows = frappe.get_all(
		"Sales Receipt",
		filters=filters,
		fields=[
			"name",
			"external_id",
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
	names = [row.name for row in rows]
	client_names = {
		row.name: row
		for row in frappe.get_all(
			"Client",
			filters={"name": ["in", [row.client for row in rows if row.client] or ["__none__"]]},
			fields=["name", "client_name", "phone"],
			limit_page_length=1000,
		)
	}
	cashier_names = {
		row.name: row.employee_name
		for row in frappe.get_all(
			"Employee",
			filters={"name": ["in", [row.cashier for row in rows if row.cashier] or ["__none__"]]},
			fields=["name", "employee_name"],
			limit_page_length=1000,
		)
	}
	payment_rows = frappe.get_all(
		"Sales Receipt Payment",
		filters={"parent": ["in", names or ["__none__"]]},
		fields=["parent", "payment_channel", "amount"],
		limit_page_length=5000,
	)
	payments = {}
	for payment in payment_rows:
		payments.setdefault(payment.parent, []).append(payment.payment_channel)

	result = []
	for row in rows:
		client = client_names.get(row.client)
		channels = list(dict.fromkeys(payments.get(row.name, [])))
		result.append(
			{
				"id": row.name,
				"externalId": row.external_id,
				"receiptNumber": _fiscal_number(row.comment, row.name),
				"createdAt": str(row.posting_datetime),
				"customerName": client.client_name if client else "Розничный покупатель",
				"customerPhone": client.phone if client else None,
				"cashierName": cashier_names.get(row.cashier) or row.cashier,
				"paymentLabel": " + ".join(channels) if channels else "—",
				"totalMinor": round(flt(row.total_amount) * 100),
				"discountMinor": round(flt(row.discount_amount) * 100),
				"reviewDiscountMinor": round(flt(row.review_discount_amount) * 100),
				"status": row.status,
			}
		)
	base_pos._touch(connection)
	return {"rows": result}
