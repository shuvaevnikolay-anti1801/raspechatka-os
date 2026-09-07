# ruff: noqa: RUF001

"""Read-only sales mirror from MoySklad into Raspechatka OS.

MoySklad remains the operational system during the transition. Imported
receipts are submitted so sales analytics work, while mirror_only prevents
them from creating a second stock, profitability, or client movement.
"""

import json
from collections import defaultdict
from datetime import timedelta

import frappe
from frappe import _
from frappe.utils import cint, flt, get_datetime, now_datetime
from raspechatka.access import require_access
from raspechatka.sales import update_shift_totals

from raspechatka.api.moysklad import MoySkladRequestError, _ref_id, _request

HISTORY_START = "2026-07-01"
JOB_NAME = "raspechatka-moysklad-sales-sync"
PAGE_SIZE = 100
ENDPOINTS = (
	("shifts", "entity/retailshift"),
	("sales", "entity/retaildemand"),
	("returns", "entity/retailsalesreturn"),
	("cash_in", "entity/retaildrawercashin"),
	("cash_out", "entity/retaildrawercashout"),
)


@frappe.whitelist()
def get_sales_sync_settings():
	require_access("settings.access", "admin")
	settings = frappe.get_single("MoySklad Settings")
	stats = _load_json(settings.sales_sync_stats_json)
	return {
		"enabled": bool(settings.sales_sync_enabled),
		"sync_from": str(settings.sales_sync_from or HISTORY_START),
		"interval_minutes": cint(settings.sales_sync_interval_minutes or 5),
		"status": settings.sales_sync_status or "Idle",
		"last_sync_at": settings.last_sales_sync_at,
		"error": settings.sales_sync_error,
		"stats": stats,
		"error_examples": _error_examples(stats),
		"points": frappe.get_all(
			"Business Point",
			filters={"active": 1},
			fields=[
				"name",
				"point_name",
				"city",
				"moysklad_retail_store_id",
				"moysklad_retail_store_name",
			],
			order_by="point_name asc",
		),
	}


@frappe.whitelist(methods=["POST"])
def discover_sales_sources():
	require_access("settings.access", "admin")
	settings = frappe.get_single("MoySklad Settings")
	payload = _request(settings, "entity/retailstore", params={"limit": 100, "offset": 0})
	return {
		"stores": [
			{
				"id": row.get("id"),
				"name": row.get("name") or row.get("id"),
				"archived": bool(row.get("archived")),
			}
			for row in payload.get("rows") or []
			if row.get("id")
		]
	}


@frappe.whitelist(methods=["POST"])
def save_sales_sync_settings(data):
	require_access("settings.access", "admin")
	data = frappe.parse_json(data) or {}
	settings = frappe.get_single("MoySklad Settings")
	settings.sales_sync_enabled = cint(data.get("enabled"))
	settings.sales_sync_from = HISTORY_START
	settings.sales_sync_interval_minutes = str(max(5, min(cint(data.get("interval_minutes") or 5), 60)))

	mappings = data.get("mappings") or []
	used_sources = set()
	for mapping in mappings:
		point_name = mapping.get("point")
		source_id = (mapping.get("source_id") or "").strip()
		if not point_name or not frappe.db.exists("Business Point", point_name):
			frappe.throw(_("Не найдена точка Распечатка OS"))
		if source_id and source_id in used_sources:
			frappe.throw(_("Одну точку МойСклада нельзя связать с несколькими точками"))
		if source_id:
			used_sources.add(source_id)
		frappe.db.set_value(
			"Business Point",
			point_name,
			{
				"moysklad_retail_store_id": source_id or None,
				"moysklad_retail_store_name": mapping.get("source_name") if source_id else None,
			},
		)

	settings.save(ignore_permissions=True)
	return get_sales_sync_settings()


@frappe.whitelist(methods=["POST"])
def start_sales_sync(full=0):
	require_access("settings.access", "admin")
	return enqueue_sales_sync(full=bool(cint(full)))


def enqueue_sales_sync(full=False):
	settings = frappe.get_single("MoySklad Settings")
	if not settings.get_password("access_token", raise_exception=False):
		return {"queued": False, "reason": "token_missing"}
	if settings.sales_sync_status in ("Queued", "Running"):
		return {"queued": False, "reason": "already_running"}
	if not frappe.db.exists("Business Point", {"moysklad_retail_store_id": ["!=", ""], "active": 1}):
		return {"queued": False, "reason": "point_mapping_missing"}
	settings.sales_sync_status = "Queued"
	settings.sales_sync_error = None
	settings.save(ignore_permissions=True)
	frappe.db.commit()
	frappe.enqueue(
		"raspechatka.api.moysklad_sales.run_sales_sync",
		queue="long",
		job_name=JOB_NAME,
		timeout=7200,
		full=full,
	)
	return {"queued": True, "full": full}


def sync_enabled_sales():
	settings = frappe.get_single("MoySklad Settings")
	if not settings.sales_sync_enabled or settings.sales_sync_status in (
		"Queued",
		"Running",
	):
		return
	if not settings.get_password("access_token", raise_exception=False):
		return
	interval = cint(settings.sales_sync_interval_minutes or 5)
	if settings.last_sales_sync_at:
		elapsed = now_datetime() - get_datetime(settings.last_sales_sync_at)
		if elapsed.total_seconds() < interval * 60:
			return
	enqueue_sales_sync(full=False)


def run_sales_sync(full=False):
	settings = frappe.get_single("MoySklad Settings")
	settings.sales_sync_status = "Running"
	settings.sales_sync_error = None
	settings.save(ignore_permissions=True)
	frappe.db.commit()

	started_at = now_datetime()
	stats = defaultdict(int)
	stats["history_from"] = HISTORY_START
	stats["mode"] = "full" if full or not settings.sales_sync_cursor else "incremental"
	stats["errors"] = []
	context = {
		"settings": settings,
		"stats": stats,
		"point_map": _point_map(),
		"employee_cache": {},
	}

	try:
		cursor = None if stats["mode"] == "full" else get_datetime(settings.sales_sync_cursor)
		for kind, endpoint in ENDPOINTS:
			for row in _iter_rows(settings, endpoint, cursor):
				_apply_safely(kind, row, context)
				if stats["processed"] and stats["processed"] % 50 == 0:
					frappe.db.commit()
		settings.reload()
		settings.sales_sync_status = "Completed"
		settings.sales_sync_cursor = started_at
		settings.last_sales_sync_at = now_datetime()
		settings.sales_sync_error = None
		settings.sales_sync_stats_json = json.dumps(dict(stats), ensure_ascii=False)
		settings.save(ignore_permissions=True)
		frappe.db.commit()
		return dict(stats)
	except Exception as exc:
		frappe.db.rollback()
		settings = frappe.get_single("MoySklad Settings")
		settings.sales_sync_status = "Error"
		settings.sales_sync_error = str(exc)[:2000]
		settings.sales_sync_stats_json = json.dumps(dict(stats), ensure_ascii=False)
		settings.save(ignore_permissions=True)
		frappe.db.commit()
		frappe.log_error(frappe.get_traceback(), "MoySklad sales sync")
		raise


def _iter_rows(settings, endpoint, cursor=None):
	offset = 0
	from_moment = f"{HISTORY_START} 00:00:00"
	if cursor:
		cursor = cursor - timedelta(minutes=10)
		filter_value = f"updated>={cursor.strftime('%Y-%m-%d %H:%M:%S')};moment>={from_moment}"
	else:
		filter_value = f"moment>={from_moment}"

	while True:
		params = {
			"limit": PAGE_SIZE,
			"offset": offset,
			"filter": filter_value,
			"order": "moment,asc",
		}
		if endpoint in ("entity/retaildemand", "entity/retailsalesreturn"):
			params["expand"] = "positions"
		payload = _request(settings, endpoint, params=params)
		rows = payload.get("rows") or []
		yield from rows
		if len(rows) < PAGE_SIZE:
			break
		offset += len(rows)


def _apply_safely(kind, row, context):
	stats = context["stats"]
	stats["processed"] += 1
	savepoint = f"moysklad_sales_{stats['processed']}"
	frappe.db.savepoint(savepoint)
	try:
		if kind == "shifts":
			_upsert_shift(row, context)
		elif kind in ("sales", "returns"):
			_upsert_receipt(row, context, is_return=kind == "returns")
		else:
			_upsert_cash_movement(row, context, is_withdrawal=kind == "cash_out")
	except Exception as exc:
		frappe.db.rollback(save_point=savepoint)
		stats["failed"] += 1
		if len(stats["errors"]) < 30:
			stats["errors"].append(
				{
					"type": kind,
					"id": row.get("id"),
					"name": row.get("name"),
					"error": str(exc)[:500],
				}
			)


def _upsert_shift(row, context):
	stats = context["stats"]
	source_id = _required_id(row)
	external_id = _external_id("retailshift", source_id)
	name = frappe.db.get_value("Sales Shift", {"external_id": external_id}, "name")
	point = _mapped_point(row, context)
	if not point:
		stats["unmapped"] += 1
		return None
	warehouse = _warehouse(point)
	if not warehouse:
		raise frappe.ValidationError(_("У точки не найден активный склад"))

	doc = frappe.get_doc("Sales Shift", name) if name else frappe.new_doc("Sales Shift")
	doc.external_id = external_id
	doc.business_point = point
	doc.business_entity = frappe.db.get_value("Business Point", point, "business_entity")
	doc.warehouse = warehouse
	doc.opened_at = _date_value(row, "moment", "openDate", "created")
	doc.closed_at = _date_value(row, "closeDate", required=False)
	doc.status = "Closed" if doc.closed_at or row.get("closed") else "Open"
	doc.cashier = _employee(row.get("cashier") or row.get("owner"), point, context)
	doc.opening_cash = _money(row.get("begin") or row.get("openingCash"))
	doc.closing_cash = _money(row.get("end") or row.get("closingCash"))
	doc.comment = row.get("description")
	doc.source = "MoySklad"
	doc.save(ignore_permissions=True)
	stats["shifts_updated" if name else "shifts_created"] += 1
	return doc.name


def _upsert_receipt(row, context, is_return=False):
	stats = context["stats"]
	source_id = _required_id(row)
	kind = "retailsalesreturn" if is_return else "retaildemand"
	external_id = _external_id(kind, source_id)
	name = frappe.db.get_value("Sales Receipt", {"external_id": external_id}, "name")
	if name and not _source_is_newer("Sales Receipt", name, row.get("updated")):
		stats["duplicates"] += 1
		return

	point = _mapped_point(row, context)
	if not point:
		stats["unmapped"] += 1
		return
	shift = _shift_from_ref(row.get("retailShift"), context)
	if not shift:
		raise frappe.ValidationError(_("Не найдена смена для чека"))
	warehouse = frappe.db.get_value("Sales Shift", shift, "warehouse")
	positions = _positions(kind, source_id, row, context["settings"])
	items = []
	for position in positions:
		moysklad_item_id = _ref_id(position.get("assortment"))
		item = frappe.db.get_value("Catalog Item", {"moysklad_id": moysklad_item_id}, "name")
		if not item:
			raise frappe.ValidationError(
				_("Не сопоставлена позиция МойСклада {0}").format(
					(position.get("assortment") or {}).get("name") or moysklad_item_id
				)
			)
		quantity = flt(position.get("quantity"))
		unit_price = _money(position.get("price"))
		discount_percent = flt(position.get("discount"))
		items.append(
			{
				"item": item,
				"quantity": quantity,
				"uom": frappe.db.get_value("Catalog Item", item, "stock_uom"),
				"unit_price": unit_price,
				"discount_percent": discount_percent,
				"discount_amount": round(quantity * unit_price * discount_percent / 100, 2),
			}
		)
	if not items:
		raise frappe.ValidationError(_("В чеке нет позиций"))
	expected_total = round(
		sum(item["quantity"] * item["unit_price"] - item["discount_amount"] for item in items),
		2,
	)
	payments = _payments(row, expected_total)

	doc = frappe.get_doc("Sales Receipt", name) if name else frappe.new_doc("Sales Receipt")
	if name and doc.docstatus == 1:
		doc.flags.ignore_validate_update_after_submit = True
	doc.external_id = external_id
	doc.receipt_type = "Return" if is_return else "Sale"
	doc.naming_series = "RETURN-.YYYY.-.#####" if is_return else "SALE-.YYYY.-.#####"
	doc.shift = shift
	doc.business_point = point
	doc.business_entity = frappe.db.get_value("Business Point", point, "business_entity")
	doc.warehouse = warehouse
	doc.posting_datetime = _date_value(row, "moment", "created")
	doc.cashier = _employee(row.get("cashier") or row.get("owner"), point, context)
	doc.original_receipt = _original_receipt(row) if is_return else None
	doc.comment = row.get("description")
	doc.source = "MoySklad"
	doc.mirror_only = 1
	doc.source_updated_at = row.get("updated")
	doc.source_payload_json = json.dumps(row, ensure_ascii=False)
	doc.set("items", items)
	doc.set("payments", payments)
	doc.save(ignore_permissions=True)
	if doc.docstatus == 0:
		doc.submit()
	else:
		update_shift_totals(doc.shift)
	key = (
		"returns_updated"
		if name and is_return
		else "returns_created"
		if is_return
		else "sales_updated"
		if name
		else "sales_created"
	)
	stats[key] += 1


def _upsert_cash_movement(row, context, is_withdrawal=False):
	stats = context["stats"]
	source_id = _required_id(row)
	kind = "retaildrawercashout" if is_withdrawal else "retaildrawercashin"
	external_id = _external_id(kind, source_id)
	if frappe.db.exists("Cash Movement", {"external_id": external_id}):
		stats["duplicates"] += 1
		return
	point = _mapped_point(row, context)
	if not point:
		stats["unmapped"] += 1
		return
	shift = _shift_from_ref(row.get("retailShift"), context)
	if not shift:
		raise frappe.ValidationError(_("Не найдена смена для кассовой операции"))
	doc = frappe.new_doc("Cash Movement")
	doc.external_id = external_id
	doc.movement_type = "Withdrawal" if is_withdrawal else "Deposit"
	doc.posting_datetime = _date_value(row, "moment", "created")
	doc.shift = shift
	doc.business_point = point
	doc.business_entity = frappe.db.get_value("Business Point", point, "business_entity")
	doc.cashier = _employee(row.get("cashier") or row.get("owner"), point, context)
	doc.amount = _money(row.get("sum") or row.get("amount"))
	doc.reason = row.get("description") or row.get("name") or _("Операция МойСклада")
	doc.source = "MoySklad"
	doc.insert(ignore_permissions=True)
	doc.submit()
	stats["cash_movements_created"] += 1


def _positions(kind, source_id, row, settings):
	value = row.get("positions") or []
	if isinstance(value, dict):
		rows = value.get("rows")
		if rows is not None:
			return rows
		if (value.get("meta") or {}).get("size") == 0:
			return []
	elif isinstance(value, list) and value:
		return value
	payload = _request(
		settings,
		f"entity/{kind}/{source_id}/positions",
		params={"limit": 1000, "offset": 0},
	)
	return payload.get("rows") or []


def _payments(row, expected_total):
	container = row.get("payments") if isinstance(row.get("payments"), dict) else {}
	cash = _money(row.get("cashSum") if row.get("cashSum") is not None else container.get("cashSum"))
	noncash = _money(row.get("noCashSum") if row.get("noCashSum") is not None else container.get("cardSum"))
	qr = _money(row.get("qrSum") if row.get("qrSum") is not None else container.get("qrSum"))
	if qr and noncash + cash + qr > expected_total + 0.01 and noncash >= qr:
		noncash -= qr
	values = [["Cash", cash], ["Card", noncash], ["QR", qr]]
	actual = round(sum(amount for _, amount in values), 2)
	if actual <= 0 and expected_total > 0:
		raise frappe.ValidationError(_("МойСклад не вернул разбивку оплаты чека"))
	difference = round(expected_total - actual, 2)
	if abs(difference) > 0.01:
		largest = max(range(len(values)), key=lambda index: values[index][1])
		values[largest][1] = round(values[largest][1] + difference, 2)
	return [{"payment_channel": channel, "amount": amount} for channel, amount in values if amount > 0]


def _shift_from_ref(reference, context):
	source_id = _ref_id(reference)
	if not source_id:
		return None
	external_id = _external_id("retailshift", source_id)
	name = frappe.db.get_value("Sales Shift", {"external_id": external_id}, "name")
	if name:
		return name
	row = _request(context["settings"], f"entity/retailshift/{source_id}")
	return _upsert_shift(row, context)


def _mapped_point(row, context):
	store_id = _ref_id(row.get("retailStore") or row.get("retailstore"))
	if not store_id and row.get("retailShift"):
		shift_id = _ref_id(row.get("retailShift"))
		shift = _request(context["settings"], f"entity/retailshift/{shift_id}") if shift_id else {}
		store_id = _ref_id(shift.get("retailStore") or shift.get("retailstore"))
	return context["point_map"].get(store_id)


def _point_map():
	return {
		row.moysklad_retail_store_id: row.name
		for row in frappe.get_all(
			"Business Point",
			filters={"active": 1, "moysklad_retail_store_id": ["!=", ""]},
			fields=["name", "moysklad_retail_store_id"],
		)
	}


def _warehouse(point):
	return frappe.db.get_value("Catalog Warehouse", {"business_point": point, "active": 1}, "name")


def _employee(reference, point, context):
	source_id = _ref_id(reference)
	if not source_id:
		return None
	if source_id not in context["employee_cache"]:
		try:
			row = _request(context["settings"], f"entity/employee/{source_id}")
		except MoySkladRequestError:
			row = {}
		email = row.get("email")
		full_name = " ".join(
			part
			for part in (
				row.get("lastName"),
				row.get("firstName"),
				row.get("middleName"),
			)
			if part
		).strip()
		name = frappe.db.get_value("Employee", {"email": email}, "name") if email else None
		if not name and full_name:
			name = frappe.db.get_value("Employee", {"employee_name": full_name}, "name")
		context["employee_cache"][source_id] = name
	name = context["employee_cache"].get(source_id)
	if name and frappe.db.exists("Employee Point Assignment", {"parent": name, "business_point": point}):
		return name
	return None


def _original_receipt(row):
	source_id = _ref_id(row.get("demand"))
	return (
		frappe.db.get_value(
			"Sales Receipt",
			{"external_id": _external_id("retaildemand", source_id)},
			"name",
		)
		if source_id
		else None
	)


def _source_is_newer(doctype, name, updated):
	if not updated:
		return False
	stored = frappe.db.get_value(doctype, name, "source_updated_at")
	return not stored or get_datetime(updated) > get_datetime(stored)


def _date_value(row, *fields, required=True):
	for field in fields:
		if row.get(field):
			return get_datetime(row[field])
	if required:
		raise frappe.ValidationError(_("В документе МойСклада отсутствует дата"))
	return None


def _money(value):
	if isinstance(value, dict):
		value = value.get("value")
	return flt(value) / 100 if value not in (None, "") else 0


def _required_id(row):
	if not row.get("id"):
		raise frappe.ValidationError(_("МойСклад вернул документ без ID"))
	return row["id"]


def _external_id(kind, source_id):
	return f"moysklad:{kind}:{source_id}"


def _load_json(value):
	try:
		return json.loads(value) if value else {}
	except (TypeError, ValueError):
		return {}


def _error_examples(stats):
	return [
		{
			**row,
			"type_label": {
				"shifts": "Смена",
				"sales": "Продажа",
				"returns": "Возврат",
				"cash_in": "Внесение",
				"cash_out": "Выплата",
			}.get(row.get("type"), "Документ"),
			"action": _error_action(row.get("error")),
		}
		for row in (stats.get("errors") or [])
	]


def _error_action(error):
	error = error or ""
	if "Не сопоставлена позиция МойСклада" in error:
		return _("Сопоставьте этот товар с товаром каталога в Распечатка OS.")
	if "Не найдена смена" in error:
		return _("Проверьте, что смена загружена и её точка сопоставлена.")
	if "активный склад" in error:
		return _("Создайте или включите склад, привязанный к этой точке.")
	if "разбивку оплаты" in error:
		return _("Проверьте суммы и типы оплат в исходном чеке МойСклада.")
	if "нет позиций" in error:
		return _("Проверьте позиции в исходном документе МойСклада.")
	if "отсутствует дата" in error or "без ID" in error:
		return _("Исправьте неполные данные в исходном документе МойСклада.")
	return _("Проверьте исходный документ и повторите полную загрузку после исправления.")
