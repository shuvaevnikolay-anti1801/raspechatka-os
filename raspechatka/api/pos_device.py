from __future__ import annotations

import hmac

import frappe
from frappe import _
from frappe.utils import cint, flt, get_datetime, now_datetime

from raspechatka.api import pos as legacy_pos
from raspechatka.api import sales as sales_api


def _authenticate(device_id, token):
	device_id = str(device_id or "").strip()
	token = str(token or "")
	name = frappe.db.get_value(
		"POS Connection", {"device_id": device_id, "enabled": 1}, "name"
	)
	if not name:
		frappe.throw(_("Касса не зарегистрирована"), frappe.AuthenticationError)
	connection = frappe.get_doc("POS Connection", name)
	stored = connection.get_password("api_token") or ""
	if not token or not hmac.compare_digest(stored, token):
		frappe.throw(_("Неверный токен кассы"), frappe.AuthenticationError)
	return connection


def _point_employees(point_name):
	assignments = frappe.get_all(
		"Employee Point Assignment",
		filters={"business_point": point_name, "parenttype": "Employee"},
		pluck="parent",
		limit_page_length=1000,
	)
	if not assignments:
		return []
	rows = frappe.get_all(
		"Employee",
		filters={"name": ["in", assignments], "active": 1},
		fields=["name", "employee_name"],
		order_by="employee_name asc",
		limit_page_length=1000,
	)
	return [{"id": row.name, "name": row.employee_name or row.name} for row in rows]


def _selected_employee(employees, cashier_id):
	cashier_id = str(cashier_id or "").strip()
	if cashier_id:
		for employee in employees:
			if employee["id"] == cashier_id:
				return employee
		frappe.throw(_("Сотрудник не прикреплён к этой точке"), frappe.PermissionError)
	return employees[0] if len(employees) == 1 else None


def _workplace(point_name):
	rows = frappe.get_all(
		"POS Workplace",
		filters={"active": 1, "business_point": point_name},
		fields=["name", "workplace_name", "workplace_code", "business_point"],
		order_by="workplace_name asc",
		limit_page_length=2,
	)
	if not rows:
		frappe.throw(_("Для точки не настроено рабочее место кассы"))
	if len(rows) > 1:
		frappe.throw(_("Для точки найдено несколько рабочих мест кассы. Оставьте одно активное рабочее место."))
	return rows[0]


def _rules(point):
	return {
		"allowFreePrice": bool(point.allow_free_price),
		"allowRemoveCartItem": bool(point.allow_remove_cart_item),
		"allowDiscounts": bool(point.allow_discounts),
		"maxDiscountPercent": flt(point.max_discount_percent),
		"acceptsCash": bool(point.accepts_cash),
		"acceptsCard": bool(point.accepts_card),
		"acceptsQr": bool(point.accepts_qr),
	}


def _touch(connection, error=None):
	connection.last_seen_at = now_datetime()
	connection.status = "Ошибка" if error else "В сети"
	connection.last_error = str(error)[:500] if error else None
	connection.save(ignore_permissions=True)


@frappe.whitelist(allow_guest=True, methods=["POST"])
def get_bootstrap(device_id, token, cashier_id=None):
	"""Bootstrap a Windows register from the point chosen in POS Connection."""
	connection = _authenticate(device_id, token)
	try:
		point = frappe.get_doc("Business Point", connection.business_point)
		if not cint(point.active):
			frappe.throw(_("Точка продаж отключена"))
		workplace = _workplace(point.name)
		employees = _point_employees(point.name)
		selected = _selected_employee(employees, cashier_id)
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
			"products": legacy_pos._get_products(point.name),
			"customers": legacy_pos._get_customers(),
			"workplaceData": legacy_pos._get_workplace_data(
				workplace_data_employee, point, workplace
			),
		}
		_touch(connection)
		return result
	except Exception as exc:
		_touch(connection, exc)
		raise


def _payment_channel(method):
	return {
		"cash": "Cash",
		"card": "Card",
		"qr": "QR",
		# Remote payment is non-cash and is kept separately in the raw event.
		# The current Sales Receipt model has only Cash/Card/QR channels.
		"remote_payment": "Card",
	}.get(str(method or "").lower())


def _sale_receipt(payload, cashier_id, receipt_type="Sale"):
	items = []
	for row in payload.get("lines") or []:
		item = str(row.get("productId") or "")
		if item.startswith("free-"):
			item = legacy_pos._resolve_legacy_pos_item(row)
		items.append({
			"item": item,
			"quantity": flt(row.get("quantity")),
			"uom": frappe.db.get_value("Catalog Item", item, "stock_uom"),
			"unit_price": flt(row.get("unitPriceMinor")) / 100,
			"discount_percent": flt(row.get("discountPercent")),
		})
	payments = []
	for payment in payload.get("payments") or []:
		channel = _payment_channel(payment.get("method"))
		if not channel:
			frappe.throw(_("Неизвестный способ оплаты {0}").format(payment.get("method")))
		payments.append({
			"payment_channel": channel,
			"amount": flt(payment.get("amountMinor")) / 100,
			"external_payment_id": payment.get("transactionId"),
		})
	return {
		"external_id": payload.get("id"),
		"receipt_type": receipt_type,
		"shift_external_id": payload.get("shiftId"),
		"posting_datetime": payload.get("createdAt"),
		"cashier": cashier_id,
		"client": payload.get("customerId"),
		"original_external_id": payload.get("saleId") if receipt_type == "Return" else None,
		"comment": (
			f"Фискальный чек: {payload.get('fiscalNumber')}"
			if payload.get("fiscalNumber") else None
		),
		"items": items,
		"payments": payments,
	}


def _shift(payload, cashier_id, closed=False):
	return {
		"external_id": payload.get("id"),
		"status": "Closed" if closed else "Open",
		"shift_type": "Regular",
		"opened_at": payload.get("openedAt"),
		"closed_at": payload.get("closedAt") if closed else None,
		"cashier": cashier_id,
		"opening_cash": 0,
		"closing_cash": flt((payload.get("summary") or {}).get("expectedCashMinor")) / 100 if closed else None,
	}


def _cash(payload, cashier_id, movement_type):
	return {
		"external_id": payload.get("id"),
		"movement_type": movement_type,
		"shift_external_id": payload.get("shiftId"),
		"posting_datetime": payload.get("createdAt"),
		"cashier": cashier_id,
		"amount": flt(payload.get("amountMinor")) / 100,
		"reason": payload.get("reason"),
	}


def _return_receipt(payload, cashier_id):
	items = []
	for row in payload.get("lines") or []:
		item = str(row.get("productId") or "")
		if not item:
			continue
		items.append({
			"item": item,
			"quantity": flt(row.get("quantity")),
			"uom": frappe.db.get_value("Catalog Item", item, "stock_uom"),
			"unit_price": flt(row.get("unitPriceMinor")) / 100,
			"discount_percent": 0,
		})
	payments = []
	for payment in payload.get("payments") or []:
		channel = _payment_channel(payment.get("method"))
		if channel:
			payments.append({"payment_channel": channel, "amount": flt(payment.get("amountMinor")) / 100, "external_payment_id": payment.get("transactionId")})
	return {
		"external_id": payload.get("id"), "receipt_type": "Return",
		"shift_external_id": payload.get("shiftId"), "posting_datetime": payload.get("createdAt"),
		"cashier": cashier_id, "original_external_id": payload.get("saleId"),
		"comment": f"Фискальный чек: {payload.get('fiscalNumber')}" if payload.get("fiscalNumber") else None,
		"items": items, "payments": payments,
	}


def _ingest_order(event_type, event_id, connection, payload):
	# Order helpers are already point-scoped through the supplied workplace.
	workplace = frappe._dict(name=connection.name, business_point=connection.business_point)
	if event_type == "order.created":
		legacy_pos._apply_order_created(event_id, workplace, payload)
	else:
		legacy_pos._apply_order_updated(event_id, workplace, payload)


@frappe.whitelist(allow_guest=True, methods=["POST"])
def push_events(device_id, token, cashier_id=None, events=None, app_version=None):
	"""Accept the Windows POS outbox using Device ID + one-time-issued token."""
	connection = _authenticate(device_id, token)
	employees = _point_employees(connection.business_point)
	selected = _selected_employee(employees, cashier_id)
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
			if event_type == "shift.opened":
				sales_api._ingest_shift(_shift(payload, selected["id"]), connection, {"created": 0, "duplicates": 0, "errors": []})
			elif event_type == "shift.closed":
				sales_api._ingest_shift(_shift(payload, selected["id"], True), connection, {"created": 0, "duplicates": 0, "errors": []}, update_existing=True)
			elif event_type == "sale.completed":
				sales_api._ingest_receipt(_sale_receipt(payload, selected["id"]), connection, {"created": 0, "duplicates": 0, "errors": []})
			elif event_type == "sale.returned":
				sales_api._ingest_receipt(_return_receipt(payload, selected["id"]), connection, {"created": 0, "duplicates": 0, "errors": []})
			elif event_type == "cash.deposited":
				sales_api._ingest_cash(_cash(payload, selected["id"], "Deposit"), connection, {"created": 0, "duplicates": 0, "errors": []})
			elif event_type == "cash.withdrawn":
				sales_api._ingest_cash(_cash(payload, selected["id"], "Withdrawal"), connection, {"created": 0, "duplicates": 0, "errors": []})
			elif event_type in ("order.created", "order.updated"):
				_ingest_order(event_type, event_id, connection, payload)
			else:
				# Do not discard unsupported operational events. Leaving them unaccepted
				# keeps them in the Windows outbox until a server handler is added.
				continue
			accepted.append(event_id)
		connection.app_version = app_version or connection.app_version
		connection.last_sync_at = now_datetime()
		_touch(connection)
		return {"accepted": accepted}
	except Exception as exc:
		_touch(connection, exc)
		raise
