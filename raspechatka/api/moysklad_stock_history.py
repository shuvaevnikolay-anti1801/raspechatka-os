# ruff: noqa: RUF001

"""Temporary MoySklad audit and stock-history migration boundary.

The module owns source-specific reading and mapping. Warehouse documents and
ledger entries are still created through the regular domain doctypes, so this
integration can later be disabled without changing warehouse accounting.
"""

import json
import unicodedata
from collections import defaultdict
from urllib.parse import urljoin

import frappe
from frappe import _
from frappe.utils import flt, get_datetime, now_datetime

from raspechatka.access import require_access
from raspechatka.api.moysklad import (
	API_BASE,
	MoySkladRequestError,
	_find_existing_catalog_item,
	_ref_id,
	_request,
)

HISTORY_START = "2026-07-01"
PAGE_SIZE = 100
SAMPLE_LIMIT = 5
JOB_NAME = "raspechatka-moysklad-stock-history"
OPENING_MOMENT = "2026-06-30 23:59:59"
IMPORT_DOCUMENTS = (
	("supply", "entity/supply", "receipt"),
	("enter", "entity/enter", "receipt"),
	("loss", "entity/loss", "write_off"),
)

# Only the three document types selected for the initial migration are audited.
STOCK_DOCUMENTS = (
	("supplies", "Приёмки", "entity/supply", "receipt"),
	("enters", "Оприходования", "entity/enter", "receipt"),
	("losses", "Списания", "entity/loss", "write_off"),
)


@frappe.whitelist()
def get_stock_history_settings():
	require_access("settings.access", "admin")
	settings = frappe.get_single("MoySklad Settings")
	from raspechatka.stock import get_active_import_batch

	return {
		"history_from": HISTORY_START,
		"status": settings.stock_history_status or "Idle",
		"last_audit_at": settings.stock_history_last_audit_at,
		"error": settings.stock_history_error,
		"preview": _load_json(settings.stock_history_preview_json),
		"initialized": bool(settings.stock_history_initialized),
		"last_sync_at": settings.stock_history_last_sync_at,
		"stats": _load_json(settings.stock_history_stats_json) or {},
		"active_import_batch": get_active_import_batch(),
		"recent_import_batches": frappe.get_all(
			"MoySklad Stock Import Batch",
			fields=["name", "status", "mode", "started_at", "completed_at"],
			order_by="creation desc",
			limit_page_length=10,
		),
	}


@frappe.whitelist(methods=["POST"])
def start_stock_history_import():
	"""Queue the explicit first import; periodic synchronization is a later mode."""
	require_access("settings.access", "admin")
	settings = frappe.get_single("MoySklad Settings")
	if not settings.get_password("access_token", raise_exception=False):
		return {"queued": False, "reason": "token_missing"}
	if settings.stock_history_status == "Running":
		return {"queued": False, "reason": "already_running"}
	settings.stock_history_status = "Running"
	settings.stock_history_error = None
	settings.save(ignore_permissions=True)
	frappe.db.commit()
	frappe.enqueue(
		"raspechatka.api.moysklad_stock_history.run_stock_history_import",
		queue="long",
		job_name=JOB_NAME,
		timeout=7200,
	)
	return {"queued": True}


@frappe.whitelist(methods=["POST"])
def start_stock_history_rebuild():
	"""Build a new immutable version and switch it on only after success."""
	require_access("settings.access", "admin")
	settings = frappe.get_single("MoySklad Settings")
	if not settings.get_password("access_token", raise_exception=False):
		return {"queued": False, "reason": "token_missing"}
	if settings.stock_history_status == "Running":
		return {"queued": False, "reason": "already_running"}
	settings.stock_history_status = "Running"
	settings.stock_history_error = None
	settings.save(ignore_permissions=True)
	frappe.db.commit()
	frappe.enqueue(
		"raspechatka.api.moysklad_stock_history.run_stock_history_import",
		queue="long",
		job_name=f"{JOB_NAME}-rebuild",
		timeout=7200,
		rebuild=True,
	)
	return {"queued": True}


def run_stock_history_import(rebuild=False):
	"""Replay source receipts and existing mirrored sales in source chronology."""
	settings = frappe.get_single("MoySklad Settings")
	stats = defaultdict(int)
	stats["history_from"] = HISTORY_START
	stats["errors"] = []
	batch = None
	try:
		batch = _start_import_batch(rebuild)
		building_batch = frappe.db.get_value("MoySklad Stock Import Batch", batch, "status") == "Running"
		stats["import_batch"] = batch
		if building_batch:
			_create_opening_documents(settings, stats, batch, replay_existing=True)
		elif not settings.stock_history_initialized:
			_assert_safe_first_import()
			_create_opening_documents(settings, stats, batch)
			settings.reload()
			settings.stock_history_initialized = 1
			settings.save(ignore_permissions=True)
			frappe.db.commit()

		events = _source_document_events(settings, stats)
		events.extend(_sales_receipt_events())
		events.sort(key=lambda row: (get_datetime(row["moment"]), row["priority"], row["key"]))

		for index, event in enumerate(events, 1):
			stats["processed"] += 1
			savepoint = f"moysklad_stock_history_{index}"
			frappe.db.savepoint(savepoint)
			try:
				if event["kind"] == "sales_receipt":
					_backfill_sales_stock(event["name"], stats, batch)
				else:
					_import_stock_document(event, stats, batch, replay_existing=building_batch)
			except Exception as exc:
				frappe.db.rollback(save_point=savepoint)
				stats["failed"] += 1
				if len(stats["errors"]) < 50:
					stats["errors"].append(
						{"type": event["kind"], "id": event["key"], "error": str(exc)[:500]}
					)
			if index % 25 == 0:
				frappe.db.commit()

		if stats["failed"] and building_batch:
			_fail_import_batch(batch, stats)
		else:
			_activate_import_batch(batch, stats)

		from raspechatka.stock_reconciliation import _rebuild_operational_balances

		balance_stats = _rebuild_operational_balances()
		stats["balances_rebuilt"] = balance_stats["rebuilt"]
		stats["balances_reset"] = balance_stats["reset"]
		settings.reload()
		settings.stock_history_status = "Completed with errors" if stats["failed"] else "Completed"
		if not stats["failed"]:
			settings.stock_history_initialized = 1
		settings.stock_history_last_sync_at = now_datetime()
		settings.stock_history_error = None
		settings.stock_history_stats_json = json.dumps(dict(stats), ensure_ascii=False, default=str)
		settings.save(ignore_permissions=True)
		frappe.db.commit()
		return dict(stats)
	except Exception as exc:
		frappe.db.rollback()
		if batch:
			_fail_import_batch(batch, stats, exc)
		settings = frappe.get_single("MoySklad Settings")
		settings.stock_history_status = "Error"
		settings.stock_history_error = str(exc)[:2000]
		settings.stock_history_stats_json = json.dumps(dict(stats), ensure_ascii=False, default=str)
		settings.save(ignore_permissions=True)
		frappe.db.commit()
		frappe.log_error(frappe.get_traceback(), "MoySklad stock history import")
		raise


def _start_import_batch(rebuild):
	from raspechatka.stock import get_active_import_batch

	active = get_active_import_batch()
	if active and not rebuild:
		return active
	batch = frappe.new_doc("MoySklad Stock Import Batch")
	batch.status = "Running"
	batch.mode = "Rebuild" if rebuild or active else "Initial"
	batch.history_from = HISTORY_START
	batch.started_at = now_datetime()
	batch.insert(ignore_permissions=True)
	frappe.db.commit()
	return batch.name


def _activate_import_batch(batch, stats):
	status = frappe.db.get_value("MoySklad Stock Import Batch", batch, "status")
	if status == "Active":
		return
	for old_batch in frappe.get_all(
		"MoySklad Stock Import Batch",
		filters={"status": "Active", "name": ["!=", batch]},
		pluck="name",
	):
		frappe.db.set_value(
			"MoySklad Stock Import Batch", old_batch, "status", "Superseded", update_modified=False
		)
	frappe.db.set_value(
		"MoySklad Stock Import Batch",
		batch,
		{
			"status": "Active",
			"completed_at": now_datetime(),
			"statistics_json": json.dumps(dict(stats), ensure_ascii=False, default=str),
			"error": None,
		},
		update_modified=False,
	)


def _fail_import_batch(batch, stats, exc=None):
	if frappe.db.get_value("MoySklad Stock Import Batch", batch, "status") != "Running":
		return
	frappe.db.set_value(
		"MoySklad Stock Import Batch",
		batch,
		{
			"status": "Failed",
			"completed_at": now_datetime(),
			"statistics_json": json.dumps(dict(stats), ensure_ascii=False, default=str),
			"error": str(exc)[:2000] if exc else _("Пакет построен с ошибками и не активирован."),
		},
		update_modified=False,
	)


def _assert_safe_first_import():
	if frappe.db.count("Stock Ledger Entry"):
		frappe.throw(
			_(
				"Первый перенос складской истории разрешён только при пустом журнале движений. "
				"Существующие документы не изменены."
			)
		)


def _warehouse_map():
	rows = frappe.get_all(
		"Catalog Warehouse",
		filters={"active": 1, "moysklad_store_id": ["!=", ""]},
		fields=["name", "business_point", "moysklad_store_id"],
	)
	return {row.moysklad_store_id: row for row in rows}


def _create_opening_documents(settings, stats, import_batch, replay_existing=False):
	"""Create the source balance immediately before the requested history window."""
	warehouses = _warehouse_map()
	if not warehouses:
		frappe.throw(_("Не сопоставлены склады МоегоСклада."))
	for source_store_id, warehouse in warehouses.items():
		external_id = f"moysklad:opening:{source_store_id}:{HISTORY_START}"
		existing = frappe.db.get_value("Stock Inventory", {"external_id": external_id}, "name")
		has_batch_movement = existing and frappe.db.exists(
			"Stock Ledger Entry",
			{"voucher_type": "Stock Inventory", "voucher_no": existing, "import_batch": import_batch},
		)
		if existing and (replay_existing or not has_batch_movement):
			_replay_stock_document(frappe.get_doc("Stock Inventory", existing), import_batch)
			stats["opening_replayed"] += 1
			continue
		if existing:
			stats["opening_duplicates"] += 1
			continue
		rows = _stock_at_moment(settings, source_store_id)
		items = []
		for source in rows:
			quantity = flt(source.get("stock"))
			if abs(quantity) <= 0.000001:
				continue
			item = _resolve_catalog_item(settings, source, stats)
			if not item:
				raise frappe.ValidationError(
					_("Не сопоставлен товар начального остатка: {0}").format(
						source.get("name") or _ref_id(source.get("assortment") or source.get("meta"))
					)
				)
			rate = _money(source.get("price") or source.get("buyPrice"))
			if rate <= 0:
				rate = _catalog_buy_rate(item) or 0.01
			items.append(
				{
					"item": item,
					"uom": frappe.db.get_value("Catalog Item", item, "stock_uom"),
					"counted_quantity": quantity,
					"valuation_rate": rate,
				}
			)
		if not items:
			continue
		entity = frappe.db.get_value("Business Point", warehouse.business_point, "business_entity")
		doc = frappe.new_doc("Stock Inventory")
		doc.business_entity = entity
		doc.business_point = warehouse.business_point
		doc.warehouse = warehouse.name
		doc.posting_datetime = OPENING_MOMENT
		doc.reason = _("Остаток МоегоСклада перед началом истории")
		doc.source = "MoySklad Opening Balance"
		doc.external_id = external_id
		doc.remarks = _("Техническая точка на 30.06.2026 для переноса движений с 01.07.2026")
		doc.set("items", items)
		doc.flags.ignore_stock_chronology = True
		doc.flags.import_batch = import_batch
		doc.insert(ignore_permissions=True)
		doc.submit()
		stats["opening_documents"] += 1
		stats["opening_lines"] += len(items)


def _stock_at_moment(settings, source_store_id):
	store_href = urljoin(API_BASE, f"entity/store/{source_store_id}")
	return list(
		_iter_report_rows(
			settings,
			"report/stock/all",
			{
				"filter": f"store={store_href}",
				"stockMode": "all",
				"moment": OPENING_MOMENT,
			},
		)
	)


def _iter_report_rows(settings, endpoint, base_params):
	offset = 0
	while True:
		params = {**base_params, "limit": PAGE_SIZE, "offset": offset}
		payload = _request(settings, endpoint, params=params)
		rows = payload.get("rows") or []
		yield from rows
		if len(rows) < PAGE_SIZE:
			break
		offset += len(rows)


def _source_document_events(settings, stats):
	events = []
	for source_kind, endpoint, target in IMPORT_DOCUMENTS:
		for row in _iter_documents(settings, endpoint):
			if row.get("applicable") is False:
				stats["not_applicable"] += 1
				continue
			row["_positions"] = _positions(settings, source_kind, row)
			events.append(
				{
					"kind": target,
					"source_kind": source_kind,
					"key": row.get("id"),
					"moment": row.get("moment") or row.get("created"),
					"priority": 10 if target == "receipt" else 30,
					"source": row,
				}
			)
	return events


def _sales_receipt_events():
	rows = frappe.get_all(
		"Sales Receipt",
		filters={
			"source": "MoySklad",
			"docstatus": 1,
			"posting_datetime": [">=", f"{HISTORY_START} 00:00:00"],
		},
		fields=["name", "external_id", "posting_datetime", "receipt_type"],
		limit_page_length=0,
	)
	return [
		{
			"kind": "sales_receipt",
			"key": row.external_id or row.name,
			"name": row.name,
			"moment": row.posting_datetime,
			"priority": 20 if row.receipt_type == "Sale" else 30,
		}
		for row in rows
	]


def _positions(settings, source_kind, row):
	container = row.get("positions") or {}
	if isinstance(container, dict) and container.get("rows") is not None:
		return container.get("rows") or []
	if isinstance(container, list) and container:
		return container
	return list(
		_iter_report_rows(
			settings,
			f"entity/{source_kind}/{row['id']}/positions",
			{},
		)
	)


def _import_stock_document(event, stats, import_batch, replay_existing=False):
	row = event["source"]
	external_id = f"moysklad:{event['source_kind']}:{event['key']}"
	doctype = "Stock Receipt" if event["kind"] == "receipt" else "Stock Write Off"
	existing = frappe.db.get_value(doctype, {"external_id": external_id}, "name")
	has_batch_movement = existing and frappe.db.exists(
		"Stock Ledger Entry",
		{"voucher_type": doctype, "voucher_no": existing, "import_batch": import_batch},
	)
	if existing and (replay_existing or not has_batch_movement):
		_replay_stock_document(frappe.get_doc(doctype, existing), import_batch)
		stats["document_replayed"] += 1
		return
	if existing:
		stats["document_duplicates"] += 1
		return
	warehouse = _mapped_warehouse(row.get("store"))
	items = _document_items(
		frappe.get_single("MoySklad Settings"),
		row,
		stats,
		incoming=event["kind"] == "receipt",
	)
	if not items:
		stats["empty_documents"] += 1
		return
	entity = frappe.db.get_value("Business Point", warehouse.business_point, "business_entity")
	doc = frappe.new_doc(doctype)
	doc.business_entity = entity
	doc.business_point = warehouse.business_point
	doc.warehouse = warehouse.name
	doc.posting_datetime = row.get("moment") or row.get("created")
	doc.source = "MoySklad"
	doc.external_id = external_id
	doc.source_updated_at = row.get("updated")
	doc.source_payload_json = json.dumps(row, ensure_ascii=False, default=str)
	doc.remarks = row.get("description")
	if event["kind"] == "receipt":
		doc.receipt_type = "Приёмка" if event["source_kind"] == "supply" else "Оприходование"
		if doc.receipt_type == "Приёмка":
			doc.supplier = _supplier(row.get("agent"))
			doc.supplier_document_number = row.get("incomingNumber") or row.get("name")
			doc.supplier_document_date = (row.get("incomingDate") or row.get("moment") or "")[:10]
		else:
			doc.reason = row.get("description") or row.get("name") or _("Оприходование МоегоСклада")
	else:
		doc.reason = row.get("description") or row.get("name") or _("Списание МоегоСклада")
	doc.set("items", items)
	doc.flags.ignore_stock_chronology = True
	doc.flags.import_batch = import_batch
	doc.insert(ignore_permissions=True)
	doc.submit()
	stats[f"{event['source_kind']}_created"] += 1


def _replay_stock_document(doc, import_batch):
	doc.flags.import_batch = import_batch
	if doc.doctype == "Stock Receipt":
		doc._make_ledger_entries()
		return
	for row in doc.items:
		from raspechatka.stock import get_average_rate, get_balance, make_ledger_entry

		if doc.doctype == "Stock Inventory":
			book_quantity = get_balance(
				row.item,
				doc.warehouse,
				row.storage_location,
				doc.posting_datetime,
				import_batch_override=import_batch,
			)["qty"]
			quantity = flt(row.counted_quantity) - flt(book_quantity)
			rate = flt(row.valuation_rate)
			amount = quantity * rate
		else:
			quantity = -flt(row.quantity)
			rate = get_average_rate(
				row.item,
				doc.warehouse,
				doc.posting_datetime,
				import_batch,
			)
			amount = quantity * rate

		make_ledger_entry(doc, row, quantity, rate, amount)


def _mapped_warehouse(reference):
	source_id = _ref_id(reference)
	warehouse = _warehouse_map().get(source_id)
	if not warehouse:
		frappe.throw(_("Не сопоставлен склад документа МоегоСклада."))
	return warehouse


def _document_items(settings, row, stats, incoming):
	items = []
	for position in row.get("_positions") or []:
		reference = position.get("assortment") or {}
		source_item_id = _ref_id(reference)
		source_kind = _assortment_kind(reference)
		if source_kind == "service":
			stats["service_positions_skipped"] += 1
			continue
		item = _resolve_catalog_item(settings, position, stats)
		if not item:
			label = reference.get("name") or source_item_id
			if source_kind:
				label = f"{label} ({source_kind})"
			raise frappe.ValidationError(_("Не сопоставлена позиция МоегоСклада {0}").format(label))
		item_row = {
			"item": item,
			"uom": frappe.db.get_value("Catalog Item", item, "stock_uom"),
			"quantity": flt(position.get("quantity")),
		}
		if incoming:
			rate = _money(position.get("price"))
			discount = flt(position.get("discount"))
			item_row["rate"] = rate * (1 - discount / 100) if rate > 0 else _catalog_buy_rate(item) or 0.01
		items.append(item_row)
	return items


def _assortment_kind(reference):
	meta = reference.get("meta") if isinstance(reference.get("meta"), dict) else reference
	source_kind = str(meta.get("type") or "").lower()
	if source_kind:
		return source_kind
	href = str(meta.get("href") or "").split("?", 1)[0].rstrip("/")
	parts = href.split("/")
	if "entity" in parts and parts.index("entity") + 1 < len(parts):
		return parts[parts.index("entity") + 1].lower()
	return ""


def _resolve_catalog_item(settings, source, stats):
	"""Resolve and permanently bind one unlinked catalog card without guessing."""
	reference = source.get("assortment") or source.get("meta") or {}
	source_id = _ref_id(reference)
	if not source_id:
		return None

	source_kind = _assortment_kind(reference)
	if source_kind not in {"product", "variant", "consignment"}:
		return None

	item = frappe.db.get_value("Catalog Item", {"moysklad_id": source_id}, "name")
	if item:
		_repair_stock_item_flags(item, source_kind, stats)
		return item

	source_row = _request(settings, f"entity/{source_kind}/{source_id}")
	if source_kind == "consignment":
		return _resolve_catalog_item(
			settings,
			{"assortment": source_row.get("assortment") or source_row.get("product") or {}},
			stats,
		)
	item = _find_existing_catalog_item(source_row, "Product")
	if not item:
		item = _find_existing_catalog_item(source_row, "Variant")
	if not item:
		item = _find_catalog_alias(source_row)
	if not item:
		return None
	existing_source_id = frappe.db.get_value("Catalog Item", item, "moysklad_id")
	if existing_source_id and existing_source_id != source_id:
		stats["catalog_aliases_reused"] += 1
		return item
	frappe.db.set_value(
		"Catalog Item",
		item,
		{
			"moysklad_id": source_id,
			"moysklad_updated_at": source_row.get("updated"),
			"moysklad_payload_json": json.dumps(source_row, ensure_ascii=False, default=str),
		},
		update_modified=False,
	)
	stats["catalog_links_recovered"] += 1
	_repair_stock_item_flags(item, source_kind, stats)
	return item


def _repair_stock_item_flags(item, source_kind, stats):
	"""Restore stock flags when an authoritative MoySklad product link is stale."""
	if source_kind not in {"product", "variant"}:
		return
	row = frappe.db.get_value(
		"Catalog Item",
		item,
		["item_type", "track_inventory"],
		as_dict=True,
	)
	if not row:
		return
	expected_type = "Variant" if source_kind == "variant" else "Product"
	if row.item_type == expected_type and row.track_inventory:
		return
	frappe.db.set_value(
		"Catalog Item",
		item,
		{"item_type": expected_type, "track_inventory": 1},
		update_modified=False,
	)
	stats["catalog_stock_flags_recovered"] += 1


def _find_catalog_alias(source_row):
	"""Use one normalized catalog match, including cards carrying a legacy source ID."""
	checks = (
		("external_code", source_row.get("externalCode")),
		("article", source_row.get("article")),
		("item_code", source_row.get("code")),
		("item_name", source_row.get("name")),
	)
	for fieldname, source_value in checks:
		needle = _normalized_catalog_value(source_value)
		if not needle:
			continue
		rows = frappe.get_all(
			"Catalog Item",
			filters={"item_type": ["in", ["Product", "Variant"]]},
			fields=["name", fieldname],
			limit_page_length=0,
		)
		matches = [row.name for row in rows if _normalized_catalog_value(row.get(fieldname)) == needle]
		if len(matches) == 1:
			return matches[0]
	return None


def _normalized_catalog_value(value):
	value = unicodedata.normalize("NFKC", str(value or ""))
	value = value.translate(str.maketrans({"«": '"', "»": '"', "“": '"', "”": '"', "„": '"'}))
	return " ".join(value.casefold().split())


def _supplier(reference):
	source_id = _ref_id(reference)
	if not source_id:
		frappe.throw(_("В приёмке МоегоСклада не указан поставщик."))
	name = frappe.db.get_value("Catalog Supplier", {"moysklad_id": source_id}, "name")
	if name:
		return name
	row = _request(frappe.get_single("MoySklad Settings"), f"entity/counterparty/{source_id}")
	doc = frappe.new_doc("Catalog Supplier")
	supplier_name = row.get("name") or f"Поставщик {source_id[:8]}"
	if frappe.db.exists("Catalog Supplier", supplier_name):
		supplier_name = f"{supplier_name} [МС-{source_id[:8]}]"
	doc.supplier_name = supplier_name
	doc.supplier_type = {
		"legal": "Company",
		"entrepreneur": "Individual Entrepreneur",
	}.get(row.get("companyType"), "Individual")
	doc.active = int(not row.get("archived"))
	doc.scope = "Network"
	doc.phone = row.get("phone")
	doc.email = row.get("email")
	doc.inn = row.get("inn")
	doc.kpp = row.get("kpp")
	doc.moysklad_id = source_id
	doc.moysklad_external_code = row.get("externalCode")
	doc.moysklad_payload_json = json.dumps(row, ensure_ascii=False, default=str)
	doc.insert(ignore_permissions=True)
	return doc.name


def _backfill_sales_stock(name, stats, import_batch):
	if frappe.db.exists(
		"Stock Ledger Entry",
		{"voucher_type": "Sales Receipt", "voucher_no": name, "import_batch": import_batch},
	):
		stats["sales_stock_duplicates"] += 1
		return
	doc = frappe.get_doc("Sales Receipt", name)
	doc.flags.ignore_validate_update_after_submit = True
	doc.flags.import_batch = import_batch
	for row in doc.items:
		row.valuation_rate = 0
		row.cost_amount = 0
	doc._prepare_consumed_materials()
	for row in doc.items:
		item = frappe.db.get_value("Catalog Item", row.item, ["item_type", "track_inventory"], as_dict=True)
		if item and item.item_type in {"Product", "Variant"} and item.track_inventory:
			if doc.receipt_type == "Return" and doc.original_receipt:
				row.valuation_rate = doc._get_original_rate(row.item)
			else:
				from raspechatka.stock import get_average_rate

				row.valuation_rate = get_average_rate(
					row.item,
					doc.warehouse,
					doc.posting_datetime,
					import_batch_override=import_batch,
				)
			row.cost_amount = flt(row.quantity) * flt(row.valuation_rate)
	doc.cost_amount = sum(flt(row.cost_amount) for row in doc.items)
	doc.profit_amount = (-1 if doc.receipt_type == "Return" else 1) * (
		flt(doc.total_amount) - flt(doc.cost_amount)
	)
	doc.save(ignore_permissions=True)
	doc._create_stock_entries(False)
	stats["sales_stock_created" if doc.receipt_type == "Sale" else "return_stock_created"] += 1


def _catalog_buy_rate(item):
	payload = _load_json(frappe.db.get_value("Catalog Item", item, "moysklad_payload_json")) or {}
	return _money(payload.get("buyPrice"))


def _money(value):
	if isinstance(value, dict):
		value = value.get("value")
	return flt(value) / 100 if value not in (None, "") else 0


@frappe.whitelist(methods=["POST"])
def audit_stock_history():
	"""Read source metadata and mapping coverage without changing business data."""
	require_access("settings.access", "admin")
	settings = frappe.get_single("MoySklad Settings")
	if not settings.get_password("access_token", raise_exception=False):
		frappe.throw(_("Сначала сохраните токен МоегоСклада."))

	settings.stock_history_status = "Running"
	settings.stock_history_error = None
	settings.save(ignore_permissions=True)
	frappe.db.commit()

	try:
		result = _collect_audit(settings)
		settings.reload()
		settings.stock_history_status = "Audited"
		settings.stock_history_last_audit_at = now_datetime()
		settings.stock_history_error = None
		settings.stock_history_preview_json = json.dumps(result, ensure_ascii=False, default=str)
		settings.save(ignore_permissions=True)
		frappe.db.commit()
		return result
	except Exception as exc:
		frappe.db.rollback()
		settings = frappe.get_single("MoySklad Settings")
		settings.stock_history_status = "Error"
		settings.stock_history_error = str(exc)[:2000]
		settings.save(ignore_permissions=True)
		frappe.db.commit()
		raise


def _collect_audit(settings):
	store_map = {
		row.moysklad_store_id: row.name
		for row in frappe.get_all(
			"Catalog Warehouse",
			filters={"moysklad_store_id": ["!=", ""]},
			fields=["name", "moysklad_store_id"],
		)
	}
	result = {
		"history_from": HISTORY_START,
		"audited_at": now_datetime(),
		"writes": 0,
		"documents": [],
		"totals": defaultdict(int),
	}

	for key, label, endpoint, target in STOCK_DOCUMENTS:
		bucket = {
			"key": key,
			"label": label,
			"endpoint": endpoint,
			"target": target,
			"available": True,
			"documents": 0,
			"positions": 0,
			"applicable": 0,
			"not_applicable": 0,
			"mapped_store_documents": 0,
			"unmapped_store_documents": 0,
			"missing_store_documents": 0,
			"samples": [],
		}
		try:
			for row in _iter_documents(settings, endpoint):
				_audit_document(row, bucket, store_map)
		except MoySkladRequestError as exc:
			# Some accounts do not have all optional document resources enabled.
			# Preserve that fact in the audit instead of hiding all other results.
			bucket["available"] = False
			bucket["error"] = str(exc)[:500]
		result["documents"].append(bucket)
		for counter in (
			"documents",
			"positions",
			"applicable",
			"not_applicable",
			"mapped_store_documents",
			"unmapped_store_documents",
			"missing_store_documents",
		):
			result["totals"][counter] += bucket[counter]

	result["totals"] = dict(result["totals"])
	result["required_targets"] = sorted({row["target"] for row in result["documents"] if row["documents"]})
	return result


def _iter_documents(settings, endpoint):
	offset = 0
	while True:
		payload = _request(
			settings,
			endpoint,
			params={
				"limit": PAGE_SIZE,
				"offset": offset,
				"filter": f"moment>={HISTORY_START} 00:00:00",
				"order": "moment,asc",
			},
		)
		rows = payload.get("rows") or []
		yield from rows
		if len(rows) < PAGE_SIZE:
			break
		offset += len(rows)


def _audit_document(row, bucket, store_map):
	bucket["documents"] += 1
	positions = row.get("positions") or {}
	if isinstance(positions, dict):
		bucket["positions"] += int(
			(positions.get("meta") or {}).get("size") or len(positions.get("rows") or [])
		)
	elif isinstance(positions, list):
		bucket["positions"] += len(positions)

	if row.get("applicable") is False:
		bucket["not_applicable"] += 1
	else:
		bucket["applicable"] += 1

	store_ids = _store_ids(row)
	if not store_ids:
		bucket["missing_store_documents"] += 1
	elif all(source_id in store_map for source_id in store_ids):
		bucket["mapped_store_documents"] += 1
	else:
		bucket["unmapped_store_documents"] += 1

	if len(bucket["samples"]) < SAMPLE_LIMIT:
		bucket["samples"].append(
			{
				"id": row.get("id"),
				"name": row.get("name"),
				"moment": row.get("moment"),
				"updated": row.get("updated"),
				"applicable": row.get("applicable") is not False,
				"stores": store_ids,
			}
		)


def _store_ids(row):
	result = []
	for fieldname in ("store", "sourceStore", "targetStore"):
		source_id = _ref_id(row.get(fieldname))
		if source_id and source_id not in result:
			result.append(source_id)
	return result


def _load_json(value):
	if not value:
		return None
	try:
		return json.loads(value)
	except TypeError, ValueError:
		return None
