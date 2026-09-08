import hmac
import secrets
from datetime import timedelta

import frappe
from frappe import _
from frappe.utils import cint, flt, get_datetime, get_first_day, now_datetime, nowdate

from raspechatka.access import get_scope, require_access
from raspechatka.sales import log_cashier_action, update_shift_totals


@frappe.whitelist()
def get_sales_options():
	require_access("sales.analytics", "read")
	entity_filters, point_filters = _scope_filters()
	scope = get_scope()
	employee_filters = {"active": 1}
	if not scope["global"]:
		employee_filters["business_entity"] = scope["business_entity"] or "__none__"
	return {
		"entities": frappe.get_all("Business Entity", filters=entity_filters, fields=["name", "short_name"], order_by="short_name asc"),
		"points": frappe.get_all("Business Point", filters=point_filters, fields=["name", "point_name", "business_entity", "city"], order_by="point_name asc"),
		"cashiers": frappe.get_all("Employee", filters=employee_filters, fields=["name", "employee_name as full_name", "business_entity"], order_by="employee_name asc"),
	}


@frappe.whitelist()
def get_points_overview(from_date=None, to_date=None, business_entity=None, business_point=None):
	require_access("sales.analytics", "read")
	from_date, to_date = from_date or str(get_first_day(nowdate())), to_date or nowdate()
	filters = _business_point_filters(business_entity, business_point)
	points = frappe.get_all("Business Point", filters={"active": 1, **filters}, fields=["name", "point_name", "city", "business_entity"], order_by="point_name asc")
	result = []
	for point in points:
		shift_names = frappe.get_all("Sales Shift", filters={"business_point": point.name, "opened_at": ["between", [f"{from_date} 00:00:00", f"{to_date} 23:59:59"]], "status": ["!=", "Cancelled"]}, pluck="name", limit_page_length=100000)
		shifts = frappe.get_all("Sales Shift", filters={"name": ["in", shift_names or ["__none__"]]}, fields=["net_sales", "receipt_count", "discounts_total", "returns_total", "expected_cash"], limit_page_length=100000)
		open_shift = frappe.db.get_value("Sales Shift", {"business_point": point.name, "status": "Open"}, ["name", "opened_at", "cashier", "expected_cash"], as_dict=True)
		connection = frappe.db.get_value("POS Connection", {"business_point": point.name}, ["status", "last_sync_at", "last_seen_at", "app_version", "enabled"], as_dict=True)
		if connection:
			connection["status"] = _live_connection_status(connection)
		revenue = sum(flt(row.net_sales) for row in shifts); receipts = sum(cint(row.receipt_count) for row in shifts)
		latest_cash = frappe.db.get_value("Sales Shift", {"business_point": point.name, "status": ["!=", "Cancelled"]}, "expected_cash", order_by="opened_at desc")
		result.append({**point, "revenue": revenue, "receipt_count": receipts, "average_check": revenue / receipts if receipts else 0, "discounts": sum(flt(row.discounts_total) for row in shifts), "returns": sum(flt(row.returns_total) for row in shifts), "cash_balance": flt(open_shift.expected_cash) if open_shift else flt(latest_cash), "open_shift": open_shift, "connection": connection})
	return {"rows": result, "totals": {"revenue": sum(r["revenue"] for r in result), "receipt_count": sum(r["receipt_count"] for r in result), "discounts": sum(r["discounts"] for r in result), "returns": sum(r["returns"] for r in result)}}


@frappe.whitelist()
def get_shifts(from_date=None, to_date=None, business_entity=None, business_point=None, status=None, cashier=None, search=None, limit_page_length=100):
	require_access("sales.shifts", "read")
	filters = _document_filters("opened_at", from_date, to_date, business_entity, business_point)
	if status: filters["status"] = status
	if cashier: filters["cashier"] = cashier
	or_filters = {"name": ["like", f"%{search.strip()}%"], "external_id": ["like", f"%{search.strip()}%"]} if search else None
	rows = frappe.get_all("Sales Shift", filters=filters, or_filters=or_filters, fields=["name", "external_id", "status", "shift_type", "opened_at", "closed_at", "business_entity", "business_point", "warehouse", "cashier", "opening_cash", "closing_cash", "expected_cash", "receipt_count", "return_count", "gross_sales", "returns_total", "net_sales", "sales_before_discount", "discounts_total", "review_discounts", "other_discounts", "discounted_receipt_count", "discount_conversion", "cash_sales", "card_sales", "qr_sales", "average_check", "reviews_count", "club_registrations", "gift_orders", "gift_orders_1", "gift_orders_2", "gift_orders_3", "card_commission_amount", "qr_commission_amount", "comment"], order_by="opened_at desc", limit_page_length=min(max(cint(limit_page_length), 1), 10000))
	return {"rows": rows, "totals": {"net_sales": sum(flt(r.net_sales) for r in rows), "receipts": sum(cint(r.receipt_count) for r in rows), "returns": sum(flt(r.returns_total) for r in rows), "discounts": sum(flt(r.discounts_total) for r in rows)}}


@frappe.whitelist()
def get_shift(name):
	require_access("sales.shifts", "read")
	doc = frappe.get_doc("Sales Shift", name)
	_ensure_point(doc.business_point, doc.business_entity)
	result = doc.as_dict(no_nulls=False)
	result["receipts"] = _receipt_rows({"shift": name})
	result["cash_movements"] = frappe.get_all("Cash Movement", filters={"shift": name, "docstatus": ["!=", 2]}, fields=["name", "movement_type", "posting_datetime", "amount", "from_cash", "to_cash", "reason", "cashier", "docstatus"], order_by="posting_datetime asc", limit_page_length=10000)
	result["actions"] = frappe.get_all("Cashier Action", filters={"shift": name}, fields=["name", "action_datetime", "action_type", "cashier", "metric_value", "gift_tier", "reference_doctype", "reference_document", "details"], order_by="action_datetime asc", limit_page_length=10000)
	return result


@frappe.whitelist()
def get_receipts(receipt_type="Sale", from_date=None, to_date=None, business_entity=None, business_point=None, shift=None, cashier=None, payment_channel=None, search=None, limit_page_length=100):
	require_access("sales.receipts", "read")
	filters = _document_filters("posting_datetime", from_date, to_date, business_entity, business_point)
	filters.update({"receipt_type": receipt_type, "docstatus": ["!=", 2]})
	if shift: filters["shift"] = shift
	if cashier: filters["cashier"] = cashier
	if payment_channel:
		parents = frappe.get_all("Sales Receipt Payment", filters={"payment_channel": payment_channel}, pluck="parent", limit_page_length=100000)
		filters["name"] = ["in", parents or ["__none__"]]
	if search:
		value = f"%{search.strip()}%"
		or_filters = {"name": ["like", value], "external_id": ["like", value], "comment": ["like", value]}
	else: or_filters = None
	rows = _receipt_rows(filters, or_filters, min(max(cint(limit_page_length), 1), 10000))
	return {"rows": rows, "totals": {"amount": sum(flt(r.total_amount) for r in rows), "discount": sum(flt(r.discount_amount) for r in rows), "profit": sum(flt(r.profit_amount) for r in rows)}}


@frappe.whitelist()
def get_receipt(name):
	require_access("sales.receipts", "read")
	doc = frappe.get_doc("Sales Receipt", name)
	_ensure_point(doc.business_point, doc.business_entity)
	return doc.as_dict(no_nulls=False)


@frappe.whitelist()
def get_cash_movements(from_date=None, to_date=None, business_entity=None, business_point=None, movement_type=None, search=None, limit_page_length=100):
	require_access("sales.cash", "read")
	filters = _document_filters("posting_datetime", from_date, to_date, business_entity, business_point)
	filters["docstatus"] = ["!=", 2]
	if movement_type: filters["movement_type"] = movement_type
	or_filters = {"name": ["like", f"%{search.strip()}%"], "reason": ["like", f"%{search.strip()}%"]} if search else None
	rows = frappe.get_all("Cash Movement", filters=filters, or_filters=or_filters, fields=["name", "external_id", "movement_type", "posting_datetime", "shift", "business_entity", "business_point", "cashier", "amount", "from_cash", "to_cash", "reason", "docstatus"], order_by="posting_datetime desc", limit_page_length=min(max(cint(limit_page_length), 1), 10000))
	return {"rows": rows, "totals": {"deposits": sum(flt(r.amount) for r in rows if r.movement_type == "Deposit"), "withdrawals": sum(flt(r.amount) for r in rows if r.movement_type == "Withdrawal")}}


@frappe.whitelist()
def get_cashier_actions(from_date=None, to_date=None, business_entity=None, business_point=None, action_type=None, cashier=None, limit_page_length=200):
	require_access("sales.audit", "read")
	filters = _document_filters("action_datetime", from_date, to_date, business_entity, business_point)
	if action_type: filters["action_type"] = action_type
	if cashier: filters["cashier"] = cashier
	rows = frappe.get_all("Cashier Action", filters=filters, fields=["name", "external_id", "action_datetime", "action_type", "business_entity", "business_point", "shift", "cashier", "metric_value", "gift_tier", "reference_doctype", "reference_document", "details"], order_by="action_datetime desc", limit_page_length=min(max(cint(limit_page_length), 1), 1000))
	return {"rows": rows}


@frappe.whitelist()
def get_connections():
	require_access("sales.integration", "read")
	filters = _scope_point_filter()
	rows = frappe.get_all("POS Connection", filters=filters, fields=["name", "business_point", "business_entity", "device_id", "enabled", "status", "last_sync_at", "last_seen_at", "app_version", "last_error"], order_by="business_point asc")
	for row in rows:
		row["status"] = _live_connection_status(row)
	return {"rows": rows}


@frappe.whitelist(methods=["POST"])
def provision_connection(business_point, rotate=0):
	require_access("sales.integration", "admin")
	_ensure_point(business_point)
	name = frappe.db.get_value("POS Connection", {"business_point": business_point}, "name")
	doc = frappe.get_doc("POS Connection", name) if name else frappe.new_doc("POS Connection")
	if not name:
		doc.business_point = business_point
		doc.device_id = f"POS-{secrets.token_hex(8).upper()}"
	if not name or cint(rotate):
		token = secrets.token_urlsafe(32)
		doc.api_token = token
	else:
		token = None
	doc.enabled = 1
	doc.save(ignore_permissions=True)
	return {"name": doc.name, "device_id": doc.device_id, "token": token, "token_shown_once": bool(token)}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def push_batch(device_id, token, payload):
	connection_name = frappe.db.get_value("POS Connection", {"device_id": device_id, "enabled": 1}, "name")
	if not connection_name:
		frappe.throw(_("Касса не зарегистрирована"), frappe.AuthenticationError)
	connection = frappe.get_doc("POS Connection", connection_name)
	stored = connection.get_password("api_token")
	if not stored or not hmac.compare_digest(stored, token or ""):
		frappe.throw(_("Неверный токен кассы"), frappe.AuthenticationError)
	data = frappe.parse_json(payload) or {}
	connection.last_seen_at = now_datetime(); connection.app_version = data.get("app_version") or connection.app_version
	result = {"created": 0, "duplicates": 0, "errors": []}
	try:
		for row in data.get("shifts") or []: _ingest_shift(row, connection, result)
		for row in data.get("receipts") or []: _ingest_receipt(row, connection, result)
		for row in data.get("cash_movements") or []: _ingest_cash(row, connection, result)
		for row in data.get("actions") or []: _ingest_action(row, connection, result)
		for row in data.get("shifts") or []:
			if row.get("status") == "Closed": _ingest_shift(row, connection, result, update_existing=True)
		connection.status, connection.last_sync_at, connection.last_error = "В сети", now_datetime(), None
	except Exception as exc:
		connection.status, connection.last_error = "Ошибка", str(exc)[:500]
		connection.save(ignore_permissions=True)
		raise
	connection.save(ignore_permissions=True)
	return result


def _ingest_shift(row, connection, result, update_existing=False):
	external_id = _required(row, "external_id")
	name = frappe.db.get_value("Sales Shift", {"external_id": external_id}, "name")
	if name and not update_existing: result["duplicates"] += 1; return
	doc = frappe.get_doc("Sales Shift", name) if name else frappe.new_doc("Sales Shift")
	if not name: doc.external_id = external_id
	_set_shift_scope(doc, connection, row)
	for field in ("status", "shift_type", "opened_at", "closed_at", "cashier", "opening_cash", "closing_cash", "card_commission_amount", "qr_commission_amount", "comment"):
		if field in row: doc.set(field, row.get(field))
	doc.source = "POS"; doc.save(ignore_permissions=True)
	if not name: log_cashier_action(doc, "OPEN_SHIFT", f"{external_id}:open"); result["created"] += 1
	if doc.status == "Closed" and doc.closed_at: log_cashier_action(doc, "CLOSE_SHIFT", f"{external_id}:close")
	update_shift_totals(doc.name)


def _ingest_receipt(row, connection, result):
	external_id = _required(row, "external_id")
	if frappe.db.exists("Sales Receipt", {"external_id": external_id}): result["duplicates"] += 1; return
	doc = frappe.new_doc("Sales Receipt"); doc.external_id = external_id
	doc.receipt_type = row.get("receipt_type") or "Sale"; doc.naming_series = "RETURN-.YYYY.-.#####" if doc.receipt_type == "Return" else "SALE-.YYYY.-.#####"
	doc.shift = _shift_name(row.get("shift_external_id"), connection.business_point)
	_set_doc_scope(doc, connection, doc.shift)
	for field in ("posting_datetime", "cashier", "client", "review_discount_amount", "other_discount_amount", "promo_code", "campaign", "comment"):
		if field in row: doc.set(field, row.get(field))
	if doc.receipt_type == "Return" and row.get("original_external_id"):
		doc.original_receipt = frappe.db.get_value("Sales Receipt", {"external_id": row.get("original_external_id")}, "name")
	for item in row.get("items") or []: doc.append("items", {key: item.get(key) for key in ("item", "quantity", "uom", "unit_price", "discount_percent", "discount_amount", "storage_location")})
	for payment in row.get("payments") or []: doc.append("payments", {key: payment.get(key) for key in ("payment_channel", "payment_method", "amount", "bank_account", "external_payment_id")})
	doc.source = "POS"; doc.insert(ignore_permissions=True); doc.submit(); result["created"] += 1


def _ingest_cash(row, connection, result):
	external_id = _required(row, "external_id")
	if frappe.db.exists("Cash Movement", {"external_id": external_id}): result["duplicates"] += 1; return
	doc = frappe.new_doc("Cash Movement"); doc.external_id = external_id; doc.movement_type = _required(row, "movement_type")
	doc.shift = _shift_name(row.get("shift_external_id"), connection.business_point); _set_doc_scope(doc, connection, doc.shift)
	for field in ("posting_datetime", "cashier", "amount", "reason"):
		if field in row: doc.set(field, row.get(field))
	doc.source = "POS"; doc.insert(ignore_permissions=True); doc.submit(); result["created"] += 1


def _ingest_action(row, connection, result):
	external_id = _required(row, "external_id")
	if frappe.db.exists("Cashier Action", {"external_id": external_id}): result["duplicates"] += 1; return
	shift = _shift_name(row.get("shift_external_id"), connection.business_point)
	doc = frappe.get_doc("Sales Shift", shift)
	log_cashier_action(doc, _required(row, "action_type"), external_id, row.get("details"), row.get("metric_value") or 1, row.get("gift_tier"))
	update_shift_totals(shift); result["created"] += 1


def _required(row, key):
	value = row.get(key)
	if value in (None, ""): frappe.throw(_("В пакете кассы отсутствует поле {0}").format(key))
	return value


def _shift_name(external_id, point):
	name = frappe.db.get_value("Sales Shift", {"external_id": external_id, "business_point": point}, "name")
	if not name: frappe.throw(_("Смена {0} не найдена").format(external_id))
	return name


def _set_shift_scope(doc, connection, row):
	doc.business_point, doc.business_entity = connection.business_point, connection.business_entity
	doc.warehouse = frappe.db.get_value(
		"Catalog Warehouse",
		{"business_point": connection.business_point, "active": 1},
		"name",
	)
	if not doc.warehouse:
		frappe.throw(_("У точки нет активного склада"))


def _set_doc_scope(doc, connection, shift):
	shift_scope = frappe.db.get_value("Sales Shift", shift, ["business_entity", "business_point", "warehouse", "cashier"], as_dict=True)
	doc.business_entity, doc.business_point, doc.warehouse = shift_scope.business_entity, shift_scope.business_point, shift_scope.warehouse
	doc.cashier = getattr(doc, "cashier", None) or shift_scope.cashier


def _receipt_rows(filters, or_filters=None, limit=10000):
	rows = frappe.get_all("Sales Receipt", filters=filters, or_filters=or_filters, fields=["name", "external_id", "receipt_type", "posting_datetime", "shift", "business_entity", "business_point", "warehouse", "cashier", "client", "original_receipt", "gross_amount", "discount_amount", "total_amount", "cost_amount", "profit_amount", "promo_code", "campaign", "docstatus", "comment"], order_by="posting_datetime desc", limit_page_length=limit)
	parents = [r.name for r in rows]
	payments = frappe.get_all("Sales Receipt Payment", filters={"parent": ["in", parents or ["__none__"]]}, fields=["parent", "payment_channel", "amount"], limit_page_length=100000)
	by_parent = {}
	for p in payments: by_parent.setdefault(p.parent, {})[p.payment_channel] = by_parent.setdefault(p.parent, {}).get(p.payment_channel, 0) + flt(p.amount)
	for row in rows: row["payments"] = by_parent.get(row.name, {})
	return rows


def _document_filters(date_field, from_date=None, to_date=None, business_entity=None, business_point=None):
	filters = _scope_point_filter(business_entity, business_point)
	if from_date and to_date: filters[date_field] = ["between", [f"{from_date} 00:00:00", f"{to_date} 23:59:59"]]
	elif from_date: filters[date_field] = [">=", f"{from_date} 00:00:00"]
	elif to_date: filters[date_field] = ["<=", f"{to_date} 23:59:59"]
	return filters


def _scope_filters():
	scope = get_scope()
	if scope["global"]: return {"active": 1}, {"active": 1}
	return {"active": 1, "name": scope["business_entity"] or "__none__"}, {"active": 1, "name": ["in", scope["points"] or ["__none__"]]}


def _business_point_filters(business_entity=None, business_point=None):
	scope = get_scope(); filters = {}
	if not scope["global"]:
		if business_entity and business_entity != scope["business_entity"]: frappe.throw(_("ИП недоступно"), frappe.PermissionError)
		filters["business_entity"] = scope["business_entity"] or "__none__"
		filters["name"] = business_point if business_point in (scope["points"] or []) else ["in", scope["points"] or ["__none__"]]
	elif business_entity: filters["business_entity"] = business_entity
	if business_point:
		_ensure_point(business_point, business_entity); filters["name"] = business_point
	return filters


def _scope_point_filter(business_entity=None, business_point=None):
	scope = get_scope(); filters = {}
	if not scope["global"]:
		if business_entity and business_entity != scope["business_entity"]: frappe.throw(_("ИП недоступно"), frappe.PermissionError)
		filters["business_entity"] = scope["business_entity"] or "__none__"
		filters["business_point"] = business_point if business_point in (scope["points"] or []) else ["in", scope["points"] or ["__none__"]]
	elif business_entity: filters["business_entity"] = business_entity
	if business_point:
		_ensure_point(business_point, business_entity); filters["business_point"] = business_point
	return filters


def _ensure_point(point, entity=None):
	if not point: return
	scope = get_scope()
	if not scope["global"] and point not in (scope["points"] or []): frappe.throw(_("Точка недоступна"), frappe.PermissionError)
	if entity and frappe.db.get_value("Business Point", point, "business_entity") != entity: frappe.throw(_("Точка не относится к выбранному ИП"))


def _live_connection_status(connection):
	if not cint(connection.enabled): return "Не подключена"
	if connection.status == "Ошибка": return "Ошибка"
	if not connection.last_seen_at: return "Не подключена"
	return "Нет связи" if now_datetime() - get_datetime(connection.last_seen_at) > timedelta(minutes=15) else "В сети"
