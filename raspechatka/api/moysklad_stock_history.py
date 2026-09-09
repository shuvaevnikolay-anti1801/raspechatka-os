"""Temporary, read-only discovery of MoySklad stock history.

The integration is intentionally isolated from the warehouse domain.  This
module does not create documents or ledger entries; it inventories the source
account before the historical importer is enabled.
"""

import json
from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import now_datetime

from raspechatka.access import require_access
from raspechatka.api.moysklad import MoySkladRequestError, _ref_id, _request

HISTORY_START = "2026-07-01"
PAGE_SIZE = 100
SAMPLE_LIMIT = 5

# Only source document types that can change physical stock are inspected.
# Orders are deliberately absent: they affect expected quantities, not stock.
STOCK_DOCUMENTS = (
	("supplies", "Приёмки", "entity/supply", "receipt"),
	("enters", "Оприходования", "entity/enter", "receipt"),
	("losses", "Списания", "entity/loss", "write_off"),
	("moves", "Перемещения", "entity/move", "transfer"),
	("purchase_returns", "Возвраты поставщикам", "entity/purchasereturn", "supplier_return"),
	("demands", "Отгрузки", "entity/demand", "shipment"),
	("sales_returns", "Возвраты покупателей", "entity/salesreturn", "customer_return"),
	("retail_sales", "Розничные продажи", "entity/retaildemand", "sales_receipt"),
	("retail_returns", "Розничные возвраты", "entity/retailsalesreturn", "sales_return"),
	("processings", "Технологические операции", "entity/processing", "processing"),
)


@frappe.whitelist()
def get_stock_history_settings():
	require_access("settings.access", "admin")
	settings = frappe.get_single("MoySklad Settings")
	return {
		"history_from": HISTORY_START,
		"status": settings.stock_history_status or "Idle",
		"last_audit_at": settings.stock_history_last_audit_at,
		"error": settings.stock_history_error,
		"preview": _load_json(settings.stock_history_preview_json),
	}


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
	except (TypeError, ValueError):
		return None
