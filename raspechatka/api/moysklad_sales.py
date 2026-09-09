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

from raspechatka.api.moysklad import (
	MoySkladCatalogImportError,
	MoySkladRequestError,
	_bundle_components,
	_load_bundle_details,
	_ref_id,
	_request,
	_sync_catalog,
	_upsert_item,
)

HISTORY_START = "2026-07-01"
JOB_NAME = "raspechatka-moysklad-sales-sync"
PAGE_SIZE = 100
STALE_JOB_MINUTES = 20
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
		"failure_summary": _failure_summary(stats),
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

@frappe.whitelist(methods=["POST"])
def start_sales_recovery():
	"""Rebuild catalog links and then safely replay all retail history."""
	require_access("settings.access", "admin")
	settings = frappe.get_single("MoySklad Settings")
	if not settings.get_password("access_token", raise_exception=False):
		return {"queued": False, "reason": "token_missing"}
	if settings.sales_sync_status in ("Queued", "Running"):
		if not _sales_sync_is_stale(settings):
			return {"queued": False, "reason": "already_running"}
		_reset_stale_sales_sync(settings)
	if not frappe.db.exists("Business Point", {"moysklad_retail_store_id": ["!=", ""], "active": 1}):
		return {"queued": False, "reason": "point_mapping_missing"}
	settings.sales_sync_status = "Queued"
	settings.sales_sync_started_at = now_datetime()
	settings.sales_sync_heartbeat_at = settings.sales_sync_started_at
	settings.sales_sync_error = None
	settings.save(ignore_permissions=True)
	frappe.db.commit()
	frappe.enqueue(
		"raspechatka.api.moysklad_sales.run_sales_recovery",
		queue="long",
		job_name=f"{JOB_NAME}-recovery",
		timeout=7200,
	)
	return {"queued": True, "full": True}


def run_sales_recovery():
	"""Make item links complete before re-importing sales from 1 July."""
	settings = frappe.get_single("MoySklad Settings")
	catalog_stats = {}
	try:
		catalog_stats = _sync_catalog(settings)
	except MoySkladCatalogImportError as exc:
		# Good records were saved by the catalog synchronizer. Continue with them
		# so one malformed catalog card cannot block the whole sales history.
		catalog_stats = exc.stats
		catalog_stats["completed_with_warnings"] = 1
	except Exception as exc:
		catalog_stats = {"error": str(exc)[:500]}
		frappe.log_error(frappe.get_traceback(), "MoySklad catalog recovery")

	sales_stats = run_sales_sync(full=True)
	sales_stats["catalog_recovery"] = catalog_stats
	settings = frappe.get_single("MoySklad Settings")
	settings.sales_sync_stats_json = json.dumps(sales_stats, ensure_ascii=False)
	settings.save(ignore_permissions=True)
	frappe.db.commit()
	return sales_stats


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
	"""Enqueue an incremental import when the configured interval has elapsed."""
	settings = frappe.get_single("MoySklad Settings")
	if not settings.sales_sync_enabled:
		return
	if settings.sales_sync_status in ("Queued", "Running"):
		if not _sales_sync_is_stale(settings):
			return
		_reset_stale_sales_sync(settings)
	if not settings.get_password("access_token", raise_exception=False):
		return
	interval = cint(settings.sales_sync_interval_minutes or 5)
	if settings.last_sales_sync_at:
		elapsed = now_datetime() - get_datetime(settings.last_sales_sync_at)
		if elapsed.total_seconds() < interval * 60:
			return
	try:
		enqueue_sales_sync(full=False)
	except Exception as exc:
		frappe.db.rollback()
		settings = frappe.get_single("MoySklad Settings")
		settings.sales_sync_status = "Error"
		settings.sales_sync_error = _("Ошибка автоматической синхронизации: {0}").format(str(exc)[:1800])
		settings.save(ignore_permissions=True)
		frappe.db.commit()
		frappe.log_error(frappe.get_traceback(), "MoySklad automatic sales sync")
		raise


def run_sales_sync(full=False):
	settings = frappe.get_single("MoySklad Settings")
	settings.sales_sync_status = "Running"
	settings.sales_sync_started_at = settings.sales_sync_started_at or now_datetime()
	settings.sales_sync_heartbeat_at = now_datetime()
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
			_touch_sales_sync_heartbeat()
			for row in _iter_rows(settings, endpoint, cursor):
				_apply_safely(kind, row, context)
				if stats["processed"] and stats["processed"] % 50 == 0:
					_touch_sales_sync_heartbeat()
					frappe.db.commit()
		settings.reload()
		settings.sales_sync_status = "Completed"
		settings.sales_sync_cursor = started_at
		settings.last_sales_sync_at = now_datetime()
		settings.sales_sync_started_at = None
		settings.sales_sync_heartbeat_at = None
		settings.sales_sync_error = None
		settings.sales_sync_stats_json = json.dumps(dict(stats), ensure_ascii=False)
		settings.save(ignore_permissions=True)
		frappe.db.commit()
		return dict(stats)
	except Exception as exc:
		frappe.db.rollback()
		settings = frappe.get_single("MoySklad Settings")
		settings.sales_sync_status = "Error"
		settings.sales_sync_started_at = None
		settings.sales_sync_heartbeat_at = None
		settings.sales_sync_error = str(exc)[:2000]
		settings.sales_sync_stats_json = json.dumps(dict(stats), ensure_ascii=False)
		settings.save(ignore_permissions=True)
		frappe.db.commit()
		frappe.log_error(frappe.get_traceback(), "MoySklad sales sync")
		raise


def _sales_sync_is_stale(settings):
	"""Return true when no worker has refreshed the persistent lease in time."""
	heartbeat = settings.sales_sync_heartbeat_at or settings.sales_sync_started_at
	if not heartbeat:
		# Legacy Queued/Running values have no lease and cannot represent a live job.
		return True
	return (now_datetime() - get_datetime(heartbeat)).total_seconds() >= STALE_JOB_MINUTES * 60


def _reset_stale_sales_sync(settings):
	settings.sales_sync_status = "Error"
	settings.sales_sync_started_at = None
	settings.sales_sync_heartbeat_at = None
	settings.sales_sync_error = _(
		"Предыдущая синхронизация была прервана. Автоматический запуск восстановлен."
	)
	settings.save(ignore_permissions=True)
	frappe.db.commit()


def _touch_sales_sync_heartbeat():
	frappe.db.set_single_value(
		"MoySklad Settings",
		"sales_sync_heartbeat_at",
		now_datetime(),
		update_modified=False,
	)



def _iter_rows(settings, endpoint, cursor=None):
	"""Read a recent idempotent window for incremental runs.

	MoySklad interprets a datetime without an explicit offset in the account
	timezone, while the Frappe cursor is stored in the site/server timezone.
	Using that cursor in the API filter could therefore put the lower bound in
	the future and silently return zero rows.  A date-only rolling window avoids
	the timezone ambiguity; all import operations are upserts and remain safe to
	replay.
	"""
	offset = 0
	if cursor:
		window_start = max(
			get_datetime(HISTORY_START).date(),
			(now_datetime() - timedelta(days=7)).date(),
		)
		from_moment = f"{window_start.isoformat()} 00:00:00"
	else:
		from_moment = f"{HISTORY_START} 00:00:00"
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
		failure_key = _failure_key(exc)
		failure_reasons = stats.setdefault("failure_reasons", {})
		failure_reasons[failure_key] = failure_reasons.get(failure_key, 0) + 1
		if failure_key == "other":
			detail = _failure_detail(exc)
			other_reasons = stats.setdefault("other_failure_reasons", {})
			other_reasons[detail] = other_reasons.get(detail, 0) + 1
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



def _resolve_catalog_item(position, context):
	"""Recover a missing active or archived assortment card on demand."""

	reference = position.get("assortment") or {}
	source_id = _ref_id(reference)
	if not source_id:
		return None
	item = frappe.db.get_value("Catalog Item", {"moysklad_id": source_id}, "name")
	if item:
		return item

	meta = reference.get("meta") or {}
	source_kind = str(meta.get("type") or "").lower()
	if not source_kind:
		href = str(meta.get("href") or "")
		parts = href.split("?", 1)[0].rstrip("/").split("/")
		if "entity" in parts and parts.index("entity") + 1 < len(parts):
			source_kind = parts[parts.index("entity") + 1].lower()
	if source_kind not in {"product", "service", "bundle", "variant"}:
		return None

	resolving = context.setdefault("catalog_recovery_in_progress", set())
	if source_id in resolving:
		return None
	resolving.add(source_id)
	try:
		source_row = _request(context["settings"], f"entity/{source_kind}/{source_id}")
		component_map = {}
		if source_kind == "bundle":
			source_row = _load_bundle_details(context["settings"], source_row)
			for component in _bundle_components(source_row):
				component_reference = component.get("assortment") or {}
				component_id = _ref_id(component_reference)
				component_item = _resolve_catalog_item({"assortment": component_reference}, context)
				if component_id and component_item:
					component_map[component_id] = component_item

		item_type = {"service": "Service", "bundle": "Bundle"}.get(source_kind, "Product")
		item = _upsert_item(
			source_row,
			item_type,
			{},
			{},
			{},
			{},
			defaultdict(int),
			component_map=component_map,
		)
		if item:
			context["stats"]["catalog_items_recovered"] += 1
		return item
	finally:
		resolving.discard(source_id)


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
			item = _resolve_catalog_item(position, context)
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
	if actual <= 0 and abs(expected_total) <= 0.01:
		# A zero-total historical receipt has no payment in MoySklad. Keep one
		# zero row so the receipt document remains structurally valid.
		return [{"payment_channel": "Cash", "amount": 0}]
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


def _failure_key(exc):
	message = str(exc)
	if "Не сопоставлена позиция МойСклада" in message:
		return "catalog_item_missing"
	if "Не найдена смена для чека" in message:
		return "receipt_shift_missing"
	if "Не найдена смена для кассовой операции" in message:
		return "cash_shift_missing"
	if "разбивку оплаты чека" in message:
		return "payment_breakdown_missing"
	if "активный склад" in message:
		return "warehouse_missing"
	if "В чеке нет позиций" in message:
		return "receipt_items_missing"
	return "other"


def _failure_summary(stats):
	labels = {
		"catalog_item_missing": "Не удалось сопоставить товар",
		"receipt_shift_missing": "У чека не найдена смена",
		"cash_shift_missing": "У кассовой операции не найдена смена",
		"payment_breakdown_missing": "Нет разбивки по способам оплаты",
		"warehouse_missing": "У точки не настроен активный склад",
		"receipt_items_missing": "В чеке нет товарных позиций",
		"other": "Прочие данные МоегоСклада",
	}
	reasons = (stats or {}).get("failure_reasons") or {}
	summary = []
	for key, count in sorted(reasons.items(), key=lambda item: (-item[1], item[0])):
		if not count:
			continue
		row = {"key": key, "label": labels.get(key, labels["other"]), "count": count}
		if key == "other":
			details = (stats or {}).get("other_failure_reasons") or {}
			row["details"] = [
				{"label": message, "count": detail_count}
				for message, detail_count in sorted(
					details.items(), key=lambda item: (-item[1], item[0])
				)
				if detail_count
			]
		summary.append(row)
	return summary


def _failure_detail(exc):
	return " ".join(str(exc).split())[:300] or _("Неизвестная ошибка")


def _load_json(value):
	try:
		return json.loads(value) if value else {}
	except (TypeError, ValueError):
		return {}
