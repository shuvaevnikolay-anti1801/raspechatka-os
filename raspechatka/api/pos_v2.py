from __future__ import annotations

import re

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, now_datetime

from raspechatka.access_contract import access_contract
from raspechatka.api import pos as legacy_pos
from raspechatka.api import pos_device as base_pos
from raspechatka.api import sales as sales_api
from raspechatka.pos_settings import get_pos_sales_rules
from raspechatka.sales import log_cashier_action, update_shift_totals

POS_MIRROR_RETENTION_DAYS = 60


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
	"""The club is network-wide; POS Connection point must not narrow customers."""
	return base_pos._customers()


def _receipt_mirror(point_name):
	rows = frappe.get_all(
		"Sales Receipt",
		filters={
			"business_point": point_name,
			"receipt_type": "Sale",
			"docstatus": ["!=", 2],
			"posting_datetime": [">=", add_days(now_datetime(), -POS_MIRROR_RETENTION_DAYS)],
		},
		fields=[
			"name",
			"external_id",
			"posting_datetime",
			"shift",
			"cashier",
			"client",
			"total_amount",
			"comment",
		],
		order_by="posting_datetime desc",
		limit_page_length=2000,
	)
	if not rows:
		return []
	parents = [row.name for row in rows]
	clients = {
		row.name: row
		for row in frappe.get_all(
			"Client",
			filters={"name": ["in", [row.client for row in rows if row.client] or ["__none__"]]},
			fields=["name", "client_name", "phone"],
			limit_page_length=2000,
		)
	}
	cashiers = {
		row.name: row.employee_name
		for row in frappe.get_all(
			"Employee",
			filters={"name": ["in", [row.cashier for row in rows if row.cashier] or ["__none__"]]},
			fields=["name", "employee_name"],
			limit_page_length=2000,
		)
	}
	shifts = {
		row.name: row.external_id
		for row in frappe.get_all(
			"Sales Shift",
			filters={"name": ["in", [row.shift for row in rows if row.shift] or ["__none__"]]},
			fields=["name", "external_id"],
			limit_page_length=2000,
		)
	}

	return_rows = frappe.get_all(
		"Sales Receipt",
		filters={
			"business_point": point_name,
			"receipt_type": "Return",
			"original_receipt": ["in", parents],
			"docstatus": ["!=", 2],
		},
		fields=["name", "original_receipt", "total_amount"],
		limit_page_length=5000,
	)
	returned_minor = {}
	return_parent = {}
	for row in return_rows:
		returned_minor[row.original_receipt] = returned_minor.get(row.original_receipt, 0) + round(
			flt(row.total_amount) * 100
		)
		return_parent[row.name] = row.original_receipt
	returned_items = {}
	if return_parent:
		for item in frappe.get_all(
			"Sales Receipt Item",
			filters={"parent": ["in", list(return_parent)]},
			fields=["parent", "item", "quantity"],
			limit_page_length=20000,
		):
			key = (return_parent.get(item.parent), item.item)
			returned_items[key] = returned_items.get(key, 0) + flt(item.quantity)

	items = {}
	for item in frappe.get_all(
		"Sales Receipt Item",
		filters={"parent": ["in", parents]},
		fields=["parent", "item", "item_name", "quantity", "unit_price", "discount_percent"],
		limit_page_length=20000,
	):
		items.setdefault(item.parent, []).append(
			{
				"id": len(items.get(item.parent, [])),
				"productId": item.item,
				"name": item.item_name,
				"quantity": flt(item.quantity),
				"unitPriceMinor": round(flt(item.unit_price) * 100),
				"discountPercent": flt(item.discount_percent),
				"returnedQuantity": returned_items.get((item.parent, item.item), 0),
			}
		)
	payment_methods = {"Cash": "cash", "Card": "card", "QR": "qr"}
	payments = {}
	for payment in frappe.get_all(
		"Sales Receipt Payment",
		filters={"parent": ["in", parents]},
		fields=["parent", "payment_channel", "amount", "external_payment_id"],
		limit_page_length=10000,
	):
		payments.setdefault(payment.parent, []).append(
			{
				"method": payment_methods.get(payment.payment_channel, "card"),
				"amountMinor": round(flt(payment.amount) * 100),
				"transactionId": payment.external_payment_id,
			}
		)

	result = []
	for row in rows:
		row_payments = payments.get(row.name, [])
		methods = list(dict.fromkeys(payment["method"] for payment in row_payments))
		identifier = row.external_id or f"server:{row.name}"
		match = re.search(r"Фискальный чек:\s*([^\s]+)", str(row.comment or ""))
		client = clients.get(row.client)
		returned = returned_minor.get(row.name, 0)
		total = round(flt(row.total_amount) * 100)
		status = "returned" if returned >= total and total > 0 else "partially_returned" if returned > 0 else "completed"
		row_items = items.get(row.name, [])
		shift_external_id = shifts.get(row.shift)
		result.append(
			{
				"id": identifier,
				"serverId": row.name,
				"externalId": row.external_id,
				"pointId": point_name,
				"receiptNumber": match.group(1) if match else row.name,
				"totalMinor": total,
				"returnedMinor": returned,
				"paymentMethod": methods[0] if len(methods) == 1 else "mixed",
				"paymentMethods": methods,
				"customerName": client.client_name if client else "Розничный покупатель",
				"customerPhone": client.phone if client else None,
				"cashierId": row.cashier,
				"cashierName": cashiers.get(row.cashier) or row.cashier,
				"shiftId": shift_external_id,
				"shiftExternalId": shift_external_id,
				"searchText": " ".join(
					[
						match.group(1) if match else row.name,
						client.client_name if client else "",
						client.phone if client else "",
						cashiers.get(row.cashier) or row.cashier or "",
						" ".join(item["name"] or "" for item in row_items),
					]
				),
				"createdAt": str(row.posting_datetime),
				"status": status,
				"lines": row_items,
				"payments": row_payments,
			}
		)
	return result


def _rules(_point):
	return get_pos_sales_rules()


@frappe.whitelist(allow_guest=True, methods=["POST"])
@access_contract(auth="pos_token", action="read", scope="pos_point")
def get_bootstrap(device_id, token, cashier_id=None):
	"""Point-scoped POS bootstrap with point catalog groups and club metadata."""
	connection = base_pos._authenticate(device_id, token)
	try:
		point = frappe.get_doc("Business Point", connection.business_point)
		if not cint(point.active):
			frappe.throw(_("Точка продаж отключена"))
		workplace = base_pos._workplace(point.name)
		employees = base_pos._point_employees(point.name)
		selected = base_pos._bootstrap_employee(employees, cashier_id)
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
			"receiptMirror": _receipt_mirror(point.name),
			"retentionDays": POS_MIRROR_RETENTION_DAYS,
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
		unit_price_minor = round(flt(row.get("unitPriceMinor")))
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
	client = str(payload.get("customerId") or "").strip()
	server_club_percent = 0.0
	if client:
		club = frappe.db.get_value(
			"Client", client, ["active", "club_status", "discount_percent"], as_dict=True
		)
		if not club:
			frappe.throw(_("Клиент не найден"))
		rules = get_pos_sales_rules()
		if cint(club.active) and club.club_status == "Активен" and rules["allowDiscounts"]:
			server_club_percent = min(
				max(flt(club.discount_percent), 0), flt(rules["maxDiscountPercent"]), 100
			)
	reported_club_percent = min(max(flt(payload.get("clubDiscountPercent")), 0), 100)
	if "clubDiscountPercent" not in payload:
		reported_club_percent = server_club_percent
	if reported_club_percent and not client:
		frappe.log_error(
			message=f"POS reported club discount {reported_club_percent}% without customer",
			title="POS club discount mismatch",
		)
		reported_club_percent = 0
	elif client and abs(reported_club_percent - server_club_percent) > 0.001:
		# The receipt may have been fiscalized offline against the last confirmed snapshot.
		# Preserve that historical fact, but record its difference from current server policy.
		frappe.log_error(
			message=(
				f"Client {client}: POS applied {reported_club_percent}%, "
				f"current server discount is {server_club_percent}%"
			),
			title="POS club discount mismatch",
		)
	if receipt_discount <= 0:
		return 0, 0, 0, 0, 0, 0
	club_discount = min(
		receipt_discount,
		raw_total - round(raw_total * (1 - reported_club_percent / 100)),
	)
	if "clubDiscountMinor" in payload:
		club_discount = min(receipt_discount, max(0, round(flt(payload.get("clubDiscountMinor")))))
	remaining = max(0, receipt_discount - club_discount)
	if "reviewDiscountMinor" in payload or "manualDiscountMinor" in payload:
		review_discount = min(remaining, max(0, round(flt(payload.get("reviewDiscountMinor")))))
		remaining -= review_discount
		manual_discount = min(remaining, max(0, round(flt(payload.get("manualDiscountMinor")))))
		remaining -= manual_discount
		return (
			max(0, round(flt(payload.get("reviewCount")))),
			club_discount,
			review_discount,
			manual_discount,
			remaining,
			reported_club_percent,
		)
	per_review = max(0, round(flt(get_pos_sales_rules()["reviewDiscountPerReviewMinor"])))
	if not per_review or not remaining:
		return 0, club_discount, 0, 0, remaining, reported_club_percent
	review_count = max(0, round(remaining / per_review))
	review_discount = min(remaining, review_count * per_review)
	other_discount = max(0, remaining - review_discount)
	return review_count, club_discount, review_discount, 0, other_discount, reported_club_percent


def _sale_receipt(payload, cashier_id, connection):
	lines = payload.get("lines") or []
	payments_payload = payload.get("payments") or []
	paid_total = sum(round(flt(payment.get("amountMinor"))) for payment in payments_payload)
	gross, raw, allocated = _allocate_final_amounts(lines, paid_total)
	(
		review_count,
		club_discount,
		review_discount,
		manual_discount,
		receipt_other_discount,
		club_discount_percent,
	) = _review_breakdown(payload, connection, sum(raw), paid_total)
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
		"club_discount_percent": club_discount_percent,
		"club_discount_amount": club_discount / 100,
		"review_count": review_count,
		"manual_discount_type": payload.get("manualDiscountType"),
		"manual_discount_value": (
			flt(payload.get("manualDiscountValue")) / 100
			if payload.get("manualDiscountType") == "amount"
			else flt(payload.get("manualDiscountValue"))
		),
		"manual_discount_amount": manual_discount / 100,
		"other_discount_amount": (receipt_other_discount + line_discount) / 100,
		"source_payload_json": frappe.as_json(
			{
				"fiscalNumber": payload.get("fiscalNumber"),
				"clubDiscountPercent": club_discount_percent,
				"receiptDiscountPercent": flt(payload.get("receiptDiscountPercent")),
				"reviewCount": review_count,
				"reviewDiscountMinor": review_discount,
				"manualDiscountMinor": manual_discount,
			}
		),
		"items": items,
		"payments": payments,
	}, review_count


def _trusted_event_cashier(connection, employees, event_type, payload, fallback_cashier=None):
	"""Bind delayed events to the authenticated cashier who opened their shift."""
	shift_external_id = payload.get("id") if event_type.startswith("shift.") else payload.get("shiftId")
	shift = None
	if shift_external_id:
		shift = frappe.db.get_value(
			"Sales Shift",
			{"external_id": shift_external_id, "business_point": connection.business_point},
			["cashier", "business_point"],
			as_dict=True,
		)
	incoming = str(payload.get("cashierId") or payload.get("cashier_id") or fallback_cashier or "").strip()
	if shift:
		if incoming and incoming != shift.cashier:
			frappe.throw(
				_("Кассир события не совпадает с кассиром открытой смены"),  # noqa: RUF001
				frappe.PermissionError,
			)
		return {"id": shift.cashier}
	return base_pos._selected_employee(employees, incoming) if incoming else None


def _ingest_cash_count(event_id, payload, connection, cashier_id):
	shift = sales_api._shift_name(payload.get("shiftId"), connection.business_point)
	doc = frappe.get_doc("Sales Shift", shift)
	if doc.cashier != cashier_id:
		frappe.throw(_("Пересчёт наличных выполнен не кассиром смены"), frappe.PermissionError)
	if frappe.db.exists("Cashier Action", {"external_id": event_id}):
		return
	count_type = str(payload.get("countType") or "")
	amount = flt(payload.get("totalMinor")) / 100
	if count_type == "opening":
		doc.opening_cash = amount
	elif count_type == "closing":
		doc.closing_cash = amount
	elif count_type != "control":
		frappe.throw(_("Неизвестный тип пересчёта наличных"))
	doc.save(ignore_permissions=True)
	log_cashier_action(
		doc,
		"CASH_COUNT",
		external_id=event_id,
		details=frappe.as_json({"count_type": count_type, "amount": amount}),
	)
	update_shift_totals(shift)


@frappe.whitelist(allow_guest=True, methods=["POST"])
@access_contract(auth="pos_token", action="create", scope="pos_point")
def push_events(device_id, token, cashier_id=None, events=None, app_version=None):
	"""POS outbox ingestion with correct receipt-level discount allocation."""
	connection = base_pos._authenticate(device_id, token)
	employees = base_pos._point_employees(connection.business_point)
	events = frappe.parse_json(events) if isinstance(events, str) else (events or [])
	if not isinstance(events, list):
		frappe.throw(_("Ожидается список событий"))
	if len(events) > 100:
		frappe.throw(_("За один запрос можно передать не более 100 событий"))  # noqa: RUF001
	accepted = []
	try:
		for event in events:
			event_id = str(event.get("id") or "").strip()
			event_type = str(event.get("eventType") or "").strip()
			payload = event.get("payload") or {}
			selected = _trusted_event_cashier(connection, employees, event_type, payload, cashier_id)
			if not event_id or not event_type:
				frappe.throw(_("В событии отсутствует id или eventType"))  # noqa: RUF001
			if not selected:
				frappe.throw(_("Кассир события не назначен на текущую точку"))
			stats = {"created": 0, "duplicates": 0, "errors": []}
			if event_type == "shift.opened":
				sales_api._ingest_shift(base_pos._shift(payload, selected["id"]), connection, stats)
			elif event_type == "shift.closed":
				sales_api._ingest_shift(
					base_pos._shift(payload, selected["id"], True), connection, stats, update_existing=True
				)
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
				sales_api._ingest_receipt(
					base_pos._return_receipt(payload, selected["id"]), connection, stats
				)
			elif event_type == "cash.deposited":
				sales_api._ingest_cash(base_pos._cash(payload, selected["id"], "Deposit"), connection, stats)
			elif event_type == "cash.withdrawn":
				sales_api._ingest_cash(
					base_pos._cash(payload, selected["id"], "Withdrawal"), connection, stats
				)
			elif event_type == "cash.counted":
				_ingest_cash_count(event_id, payload, connection, selected["id"])
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
				or_filters={
					"name": ["like", value],
					"external_id": ["like", value],
					"comment": ["like", value],
				},
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
