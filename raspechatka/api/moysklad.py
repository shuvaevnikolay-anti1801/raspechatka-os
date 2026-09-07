# ruff: noqa: RUF001

import json
from collections import defaultdict
from time import sleep
from urllib.parse import urljoin

import frappe
import requests
from frappe import _
from frappe.utils import cint, flt, get_datetime, now_datetime

from raspechatka.access import require_access


API_BASE = "https://api.moysklad.ru/api/remap/1.2/"
DEFAULT_TIMEOUT = 30
REQUEST_ATTEMPTS = 4
PAGE_SIZE = 100
MIN_SYNC_INTERVAL = 15
MAX_SYNC_INTERVAL = 1440
CATALOG_JOB_NAME = "raspechatka-moysklad-catalog-sync"

SOURCES = (
	("organizations", "Организации", "Юридические лица", "entity/organization"),
	("retail_stores", "Точки продаж", "Точки продаж", "entity/retailstore"),
	("warehouses", "Склады", "Склады", "entity/store"),
	("product_groups", "Группы товаров", "Группы каталога", "entity/productfolder"),
	("units", "Единицы измерения", "Единицы измерения", "entity/uom"),
	("products", "Товары", "Товары и услуги", "entity/product"),
	("services", "Услуги", "Товары и услуги", "entity/service"),
	("bundles", "Комплекты", "Товары и услуги", "entity/bundle"),
	("variants", "Модификации", "Варианты товаров", "entity/variant"),
	("counterparties", "Контрагенты", "Поставщики / клиенты после настройки правил", "entity/counterparty"),
	("employees", "Сотрудники", "Сотрудники после сверки", "entity/employee"),
)


class MoySkladRequestError(Exception):
	def __init__(self, message, status_code=None):
		super().__init__(message)
		self.status_code = status_code


class MoySkladCatalogImportError(Exception):
	def __init__(self, message, stats):
		super().__init__(message)
		self.stats = stats


@frappe.whitelist()
def get_settings():
	require_access("settings.access", "admin")
	return _safe_settings(frappe.get_single("MoySklad Settings"))


@frappe.whitelist(methods=["POST"])
def save_settings(data):
	require_access("settings.access", "admin")
	data = frappe.parse_json(data) or {}
	doc = frappe.get_single("MoySklad Settings")
	# МойСклад используется только для разового импорта по явному действию.
	doc.enabled = 0
	if data.get("access_token"):
		doc.access_token = str(data["access_token"]).strip()
	doc.save(ignore_permissions=True)
	return _safe_settings(doc)


@frappe.whitelist(methods=["POST"])
def test_connection():
	require_access("settings.access", "admin")
	doc = frappe.get_single("MoySklad Settings")
	try:
		employee = _request(doc, "context/employee")
		account_name = employee.get("name") or employee.get("email") or _("Учётная запись МоегоСклада")
		_update_status(doc, "Connected", account_name=account_name, error_message=None)
		return {"connected": True, "account_name": account_name, "checked_at": doc.last_checked_at}
	except MoySkladRequestError as exc:
		_update_status(doc, "Error", error_message=str(exc))
		frappe.throw(str(exc))


@frappe.whitelist(methods=["POST"])
def read_preview():
	require_access("settings.access", "admin")
	doc = frappe.get_single("MoySklad Settings")
	try:
		result = _collect_preview(doc)
		_save_preview(doc, result)
		return result
	except MoySkladRequestError as exc:
		_update_status(doc, "Error", error_message=str(exc))
		frappe.throw(str(exc))


@frappe.whitelist(methods=["POST"])
def start_catalog_sync():
	require_access("settings.access", "admin")
	return enqueue_catalog_sync()


def enqueue_catalog_sync():
	doc = frappe.get_single("MoySklad Settings")
	if not _has_token(doc):
		return {"queued": False, "reason": "token_missing"}
	if doc.catalog_sync_status in ("Queued", "Running"):
		return {"queued": False, "reason": "already_running"}
	doc.catalog_sync_status = "Queued"
	doc.catalog_sync_error = None
	doc.save(ignore_permissions=True)
	frappe.db.commit()
	frappe.enqueue(
		"raspechatka.api.moysklad.run_catalog_sync",
		queue="long",
		job_name=CATALOG_JOB_NAME,
		timeout=7200,
	)
	return {"queued": True}


def run_catalog_sync():
	doc = frappe.get_single("MoySklad Settings")
	doc.catalog_sync_status = "Running"
	doc.catalog_sync_error = None
	doc.save(ignore_permissions=True)
	frappe.db.commit()
	try:
		stats = _sync_catalog(doc)
		doc.reload()
		doc.catalog_sync_status = "Completed"
		doc.last_catalog_sync_at = now_datetime()
		doc.last_checked_at = now_datetime()
		doc.last_error = None
		doc.catalog_sync_error = None
		doc.catalog_sync_stats_json = json.dumps(stats, ensure_ascii=False)
		doc.status = "Connected"
		doc.save(ignore_permissions=True)
		frappe.db.commit()
		return stats
	except Exception as exc:
		frappe.db.rollback()
		doc = frappe.get_single("MoySklad Settings")
		doc.catalog_sync_status = "Error"
		doc.catalog_sync_error = str(exc)[:2000]
		doc.last_error = str(exc)[:2000]
		if isinstance(exc, MoySkladCatalogImportError):
			doc.catalog_sync_stats_json = json.dumps(exc.stats, ensure_ascii=False)
		doc.status = "Error"
		doc.save(ignore_permissions=True)
		frappe.db.commit()
		frappe.log_error(frappe.get_traceback(), "MoySklad catalog sync")
		raise


def sync_enabled_connection():
	"""Legacy hook kept harmless for existing installations; no background sync."""
	return None


def _sync_catalog(settings):
	stats = defaultdict(int)
	groups = _active_rows(_iter_rows(settings, "entity/productfolder"), stats)
	units = _active_rows(_iter_rows(settings, "entity/uom"), stats)
	products = _active_rows(_iter_rows(settings, "entity/product"), stats)
	services = _active_rows(_iter_rows(settings, "entity/service"), stats)
	bundles = _active_rows(_iter_rows(settings, "entity/bundle"), stats)
	variants = _active_rows(_iter_rows(settings, "entity/variant"), stats)
	counterparties = {row.get("id"): row for row in _active_rows(_iter_rows(settings, "entity/counterparty"), stats)}

	group_map = _sync_groups(groups, stats)
	unit_map = _sync_units(units, stats)
	price_type_map = _sync_price_types(products + services + bundles + variants, stats)
	supplier_map = _sync_suppliers(products + services + bundles, counterparties, stats)

	stats["source_items"] = len(products) + len(services) + len(bundles) + len(variants)
	item_map = {}
	item_errors = []

	# Components in MoySklad bundles point to products or variants. Import all
	# possible component targets first, then create each bundle atomically with
	# its child rows already attached.
	for item_type, rows in (("Product", products), ("Service", services)):
		for row in rows:
			name = _safe_upsert_item(
				row, item_type, group_map, unit_map, price_type_map, supplier_map, stats, item_errors
			)
			if not name:
				continue
			item_map[row.get("id")] = name
			_commit_periodically(stats["items"])

	for row in variants:
		parent_id = _ref_id(row.get("product"))
		name = _safe_upsert_item(
			row,
			"Product",
			group_map,
			unit_map,
			price_type_map,
			supplier_map,
			stats,
			item_errors,
			variant_of=item_map.get(parent_id),
		)
		if not name:
			continue
		item_map[row.get("id")] = name
		_commit_periodically(stats["items"])

	for row in bundles:
		row = _load_bundle_details(settings, row)
		name = _safe_upsert_item(
			row,
			"Bundle",
			group_map,
			unit_map,
			price_type_map,
			supplier_map,
			stats,
			item_errors,
			component_map=item_map,
		)
		if not name:
			continue
		item_map[row.get("id")] = name
		_commit_periodically(stats["items"])

	for source_id, name in item_map.items():
		if source_id and name:
			frappe.db.set_value("Catalog Item", name, "has_variants", int(any(
				_ref_id(variant.get("product")) == source_id for variant in variants
			)), update_modified=False)

	stats["database_items"] = frappe.db.count("Catalog Item", {"moysklad_id": ["!=", ""]})
	stats["database_groups"] = frappe.db.count("Catalog Group", {"moysklad_id": ["!=", ""]})
	result = dict(stats)
	if item_errors:
		result["error_samples"] = item_errors[:20]
		frappe.db.commit()
		raise MoySkladCatalogImportError(
			_("Перенос завершён с ошибками в {0} позициях; остальные данные сохранены").format(len(item_errors)),
			result,
		)
	frappe.db.commit()
	return result


def _sync_groups(rows, stats):
	result = {}
	by_id = {row.get("id"): row for row in rows if row.get("id")}
	pending = set(by_id)
	while pending:
		progress = False
		for source_id in list(pending):
			row = by_id[source_id]
			parent_id = _ref_id(row.get("productFolder"))
			if parent_id and parent_id not in result and parent_id in by_id:
				continue
			name = _find_by_source("Catalog Group", source_id)
			doc = frappe.get_doc("Catalog Group", name) if name else frappe.new_doc("Catalog Group")
			doc.group_name = _unique_value("Catalog Group", "group_name", row.get("name") or source_id, name)
			doc.parent_catalog_group = result.get(parent_id)
			doc.is_group = int(any(_ref_id(child.get("productFolder")) == source_id for child in rows))
			doc.active = int(not row.get("archived"))
			doc.description = row.get("description")
			doc.moysklad_id = source_id
			doc.moysklad_external_code = row.get("externalCode")
			doc.moysklad_payload_json = _dump(row)
			doc.save(ignore_permissions=True)
			result[source_id] = doc.name
			pending.remove(source_id)
			stats["groups"] += 1
			progress = True
		if not progress:
			for source_id in list(pending):
				row = by_id[source_id]
				row.pop("productFolder", None)
			break
	return result


def _sync_units(rows, stats):
	result = {}
	for row in rows:
		source_id = row.get("id")
		if not source_id:
			continue
		name = _find_by_source("Catalog Unit", source_id)
		doc = frappe.get_doc("Catalog Unit", name) if name else frappe.new_doc("Catalog Unit")
		doc.unit_name = _unique_value("Catalog Unit", "unit_name", row.get("name") or source_id, name)
		doc.symbol = row.get("code") or row.get("name") or "ед."
		doc.allow_fraction = 1
		doc.active = int(not row.get("archived"))
		doc.moysklad_id = source_id
		doc.moysklad_external_code = row.get("externalCode")
		doc.moysklad_payload_json = _dump(row)
		doc.save(ignore_permissions=True)
		result[source_id] = doc.name
		stats["units"] += 1
	return result


def _sync_price_types(rows, stats):
	result = {}
	for row in rows:
		for price in row.get("salePrices") or []:
			price_type = price.get("priceType") or {}
			source_id = price_type.get("id") or _ref_id(price_type)
			label = price_type.get("name") or "Цена продажи"
			key = source_id or label
			if key in result:
				continue
			name = _find_by_source("Catalog Price Type", source_id) if source_id else frappe.db.get_value("Catalog Price Type", {"price_type_name": label}, "name")
			doc = frappe.get_doc("Catalog Price Type", name) if name else frappe.new_doc("Catalog Price Type")
			doc.price_type_name = _unique_value("Catalog Price Type", "price_type_name", label, name)
			doc.purpose = "Selling"
			doc.currency = "RUB"
			doc.active = 1
			doc.moysklad_id = source_id
			doc.moysklad_external_code = price_type.get("externalCode")
			doc.save(ignore_permissions=True)
			result[key] = doc.name
			stats["price_types"] += 1
	return result


def _sync_suppliers(rows, counterparties, stats):
	result = {}
	requested = {_ref_id(row.get("supplier")) for row in rows if row.get("supplier")}
	for source_id in requested:
		if not source_id:
			continue
		row = counterparties.get(source_id) or {"id": source_id, "name": f"Поставщик {source_id[:8]}"}
		name = _find_by_source("Catalog Supplier", source_id)
		doc = frappe.get_doc("Catalog Supplier", name) if name else frappe.new_doc("Catalog Supplier")
		doc.supplier_name = _unique_value("Catalog Supplier", "supplier_name", row.get("name") or source_id, name)
		doc.supplier_type = _supplier_type(row.get("companyType"))
		doc.active = int(not row.get("archived"))
		doc.scope = "Network"
		doc.phone = row.get("phone")
		doc.email = row.get("email")
		doc.website = row.get("website")
		doc.legal_name = row.get("legalTitle")
		doc.inn = row.get("inn")
		doc.kpp = row.get("kpp")
		doc.ogrn = row.get("ogrn")
		doc.ogrnip = row.get("ogrnip")
		doc.notes = row.get("description")
		doc.moysklad_id = source_id
		doc.moysklad_external_code = row.get("externalCode")
		doc.moysklad_payload_json = _dump(row)
		doc.save(ignore_permissions=True)
		result[source_id] = doc.name
		stats["suppliers"] += 1
	return result


def _safe_upsert_item(
	row,
	item_type,
	group_map,
	unit_map,
	price_type_map,
	supplier_map,
	stats,
	errors,
	variant_of=None,
	component_map=None,
):
	save_point = f"moysklad_item_{stats['items'] + stats['item_errors'] + 1}"
	frappe.db.savepoint(save_point)
	try:
		return _upsert_item(
			row,
			item_type,
			group_map,
			unit_map,
			price_type_map,
			supplier_map,
			stats,
			variant_of=variant_of,
			component_map=component_map,
		)
	except Exception as exc:
		frappe.db.rollback(save_point=save_point)
		stats["item_errors"] += 1
		errors.append({
			"id": row.get("id"),
			"name": row.get("name"),
			"type": item_type,
			"error": str(exc)[:500],
		})
		return None


def _upsert_item(
	row,
	item_type,
	group_map,
	unit_map,
	price_type_map,
	supplier_map,
	stats,
	variant_of=None,
	component_map=None,
):
	source_id = row.get("id")
	if not source_id:
		return None
	name = _find_by_source("Catalog Item", source_id)
	doc = frappe.get_doc("Catalog Item", name) if name else frappe.new_doc("Catalog Item")
	doc.item_code = _unique_value("Catalog Item", "item_code", _item_code(row), name)
	doc.item_name = row.get("name") or doc.item_code
	doc.item_type = item_type
	doc.catalog_group = group_map.get(_ref_id(row.get("productFolder")))
	doc.stock_uom = unit_map.get(_ref_id(row.get("uom"))) or _ensure_default_unit()
	doc.active = int(not row.get("archived"))
	doc.description = row.get("description")
	doc.article = row.get("article")
	doc.external_code = row.get("externalCode")
	doc.default_supplier = supplier_map.get(_ref_id(row.get("supplier")))
	doc.variant_of = variant_of
	doc.has_variants = cint(row.get("variantsCount")) > 0
	doc.weight = flt(row.get("weight"))
	doc.volume = flt(row.get("volume"))
	doc.minimum_sale_price = _money(row.get("minPrice"))
	doc.prevent_discounts = cint(bool(row.get("discountProhibited")))
	doc.track_inventory = int(item_type == "Product")
	doc.tracking_method = _tracking_method(row.get("trackingType"))
	doc.vat_rate = _vat_rate(row)
	doc.receipt_subject = "Услуга" if item_type == "Service" else "Товар"
	doc.moysklad_id = source_id
	doc.moysklad_updated_at = row.get("updated")
	doc.moysklad_image_url = _image_url(row)
	doc.moysklad_payload_json = _dump(row)
	doc.sync_status = "Synced"
	doc.last_synced_at = now_datetime()

	doc.set("prices", [])
	for price in row.get("salePrices") or []:
		price_type = price.get("priceType") or {}
		key = price_type.get("id") or _ref_id(price_type) or price_type.get("name") or "Цена продажи"
		linked_type = price_type_map.get(key)
		if linked_type:
			doc.append("prices", {"price_type": linked_type, "rate": _money(price), "minimum_quantity": 1})

	doc.set("barcodes", [])
	seen_barcodes = set()
	for barcode in row.get("barcodes") or []:
		value, barcode_type = _barcode(barcode)
		owner = frappe.db.get_value("Catalog Item Barcode", {"barcode": value}, "parent") if value else None
		if value and value not in seen_barcodes and owner in (None, doc.name):
			seen_barcodes.add(value)
			doc.append("barcodes", {"barcode": value, "barcode_type": barcode_type, "uom": doc.stock_uom, "quantity": 1})

	doc.set("attributes", [])
	for attribute in (row.get("attributes") or []) + (row.get("characteristics") or []):
		label = attribute.get("name") or attribute.get("id")
		value = _attribute_value(attribute.get("value"))
		if label and value not in (None, ""):
			doc.append("attributes", {"attribute_name": str(label)[:140], "attribute_value": str(value)[:140]})

	if item_type == "Bundle":
		_set_bundle_components(doc, row, component_map or {}, stats)

	doc.save(ignore_permissions=True)
	stats["items"] += 1
	stats[item_type.lower()] += 1
	return doc.name


def _load_bundle_details(settings, row):
	if _bundle_components(row):
		return row
	source_id = row.get("id")
	if not source_id:
		return row

	# Components are a separate MetaArray resource in MoySklad. The bundle
	# card may contain only its metadata even when requested by ID.
	payload = _request(
		settings,
		f"entity/bundle/{source_id}/components",
		params={"limit": 1000, "offset": 0},
	)
	result = dict(row)
	result["components"] = payload
	return result


def _bundle_components(row):
	components = row.get("components") or []
	if isinstance(components, dict):
		return components.get("rows") or []
	return components


def _set_bundle_components(doc, row, item_map, stats):
	components = _bundle_components(row)
	missing = []
	doc.set("bundle_components", [])
	for component in components:
		source_id = _ref_id(component.get("assortment"))
		item = item_map.get(source_id)
		if not item:
			missing.append(source_id or _("неизвестный компонент"))
			continue
		doc.append(
			"bundle_components",
			{
				"item": item,
				"quantity": flt(component.get("quantity") or 1),
				"uom": frappe.db.get_value("Catalog Item", item, "stock_uom"),
			},
		)

	if missing:
		raise frappe.ValidationError(
			_("Не найдены товары состава комплекта: {0}").format(", ".join(missing))
		)
	if not doc.bundle_components:
		raise frappe.ValidationError(_("В МоемСкладе у комплекта не указан состав."))
	stats["bundle_components"] += len(doc.bundle_components)


def _collect_preview(doc):
	employee = _request(doc, "context/employee")
	rows = []
	for code, label, target, endpoint in SOURCES:
		try:
			payload = _request(doc, endpoint, params={"limit": 3})
			meta = payload.get("meta") or {}
			samples = [row.get("name") for row in payload.get("rows") or [] if row.get("name")]
			rows.append({"code": code, "label": label, "target": target, "count": int(meta.get("size") or len(payload.get("rows") or [])), "samples": samples, "available": True, "error": None})
		except MoySkladRequestError as exc:
			if exc.status_code in (401, 429):
				raise
			rows.append({"code": code, "label": label, "target": target, "count": None, "samples": [], "available": False, "error": str(exc)})
	return {"mode": "preview", "writes": 0, "account_name": employee.get("name") or employee.get("email"), "read_at": str(now_datetime()), "sources": rows}


def _iter_rows(doc, endpoint):
	offset = 0
	while True:
		payload = _request(doc, endpoint, params={"limit": PAGE_SIZE, "offset": offset})
		rows = payload.get("rows") or []
		yield from rows
		if len(rows) < PAGE_SIZE:
			break
		offset += len(rows)


def _request(doc, endpoint, params=None):
	token = doc.get_password("access_token", raise_exception=False)
	if not token:
		raise MoySkladRequestError(_("Сохраните токен МоегоСклада"))

	last_error = None
	for attempt in range(REQUEST_ATTEMPTS):
		try:
			response = requests.get(
				urljoin(API_BASE, endpoint),
				headers={"Authorization": f"Bearer {token}", "Accept-Encoding": "gzip", "User-Agent": "Raspechatka-OS/1.0"},
				params=params,
				timeout=DEFAULT_TIMEOUT,
			)
		except requests.Timeout as exc:
			last_error = MoySkladRequestError(_("МойСклад не ответил за отведённое время"))
			if attempt == REQUEST_ATTEMPTS - 1:
				raise last_error from exc
			sleep(_retry_delay(attempt))
			continue
		except requests.RequestException as exc:
			last_error = MoySkladRequestError(_("Не удалось соединиться с МоимСкладом"))
			if attempt == REQUEST_ATTEMPTS - 1:
				raise last_error from exc
			sleep(_retry_delay(attempt))
			continue

		if response.ok:
			try:
				return response.json()
			except ValueError as exc:
				raise MoySkladRequestError(_("МойСклад вернул некорректный ответ")) from exc

		messages = {
			401: _("Токен МоегоСклада недействителен"),
			403: _("У токена нет доступа к этим данным МоегоСклада"),
			404: _("Раздел данных не поддерживается аккаунтом МоегоСклада"),
			429: _("МойСклад временно ограничил число запросов"),
		}
		last_error = MoySkladRequestError(
			messages.get(response.status_code, _("МойСклад вернул ошибку {0}").format(response.status_code)),
			response.status_code,
		)
		if response.status_code != 429 and response.status_code < 500:
			raise last_error
		if attempt == REQUEST_ATTEMPTS - 1:
			raise last_error
		sleep(_retry_delay(attempt, response.headers.get("Retry-After")))

	raise last_error or MoySkladRequestError(_("Не удалось получить ответ МоегоСклада"))


def _retry_delay(attempt, retry_after=None):
	try:
		return min(30.0, max(0.0, float(retry_after)))
	except (TypeError, ValueError):
		return min(8, 2**attempt)

def _safe_settings(doc):
	preview = _load_json(doc.last_preview_json)
	stats = _load_json(doc.catalog_sync_stats_json)
	return {
		"enabled": bool(doc.enabled),
		"catalog_sync_status": doc.catalog_sync_status or "Idle",
		"catalog_sync_error": doc.catalog_sync_error,
		"catalog_sync_stats": stats,
		"last_catalog_sync_at": doc.last_catalog_sync_at,
		"sync_interval_minutes": int(doc.sync_interval_minutes or 60),
		"status": doc.status or "Not configured",
		"account_name": doc.account_name,
		"last_checked_at": doc.last_checked_at,
		"last_error": doc.last_error,
		"has_token": _has_token(doc),
		"api_base": API_BASE.rstrip("/"),
		"preview": preview,
		"import_enabled": True,
	}


def _find_by_source(doctype, source_id):
	return frappe.db.get_value(doctype, {"moysklad_id": source_id}, "name") if source_id else None


def _unique_value(doctype, fieldname, value, current_name=None):
	value = str(value or "").strip()[:140] or "Без названия"
	candidate = value
	index = 2
	while True:
		existing = frappe.db.get_value(doctype, {fieldname: candidate}, "name")
		if not existing or existing == current_name:
			return candidate
		candidate = f"{value[:132]} ({index})"
		index += 1


def _ensure_default_unit():
	name = frappe.db.get_value("Catalog Unit", {"unit_name": "Штука"}, "name")
	if name:
		return name
	doc = frappe.get_doc({"doctype": "Catalog Unit", "unit_name": "Штука", "symbol": "шт.", "active": 1})
	doc.insert(ignore_permissions=True)
	return doc.name


def _item_code(row):
	return row.get("code") or row.get("article") or row.get("externalCode") or f"MS-{str(row.get('id') or '')[:12]}"


def _ref_id(value):
	if not isinstance(value, dict):
		return None
	if value.get("id"):
		return value["id"]
	href = (value.get("meta") or value).get("href")
	return href.rstrip("/").rsplit("/", 1)[-1] if href else None


def _money(value):
	if isinstance(value, dict):
		value = value.get("value")
	return flt(value) / 100 if value not in (None, "") else 0


def _barcode(row):
	for key, kind in (("ean13", "EAN-13"), ("ean8", "EAN-8"), ("upc", "UPC-A"), ("gtin", "GTIN"), ("gtin14", "GTIN-14"), ("code128", "Other")):
		if row.get(key):
			return str(row[key]), kind
	return None, "Other"


def _attribute_value(value):
	if isinstance(value, dict):
		return value.get("name") or value.get("value") or value.get("id") or _dump(value)
	if isinstance(value, list):
		return ", ".join(str(_attribute_value(item)) for item in value)
	return value


def _image_url(row):
	images = row.get("images") or {}
	if isinstance(images, dict):
		images = images.get("rows") or []
	if not images:
		return None
	meta = images[0].get("meta") or {}
	return meta.get("downloadHref") or meta.get("href")


def _vat_rate(row):
	if not row.get("vatEnabled", True):
		return "Без НДС"
	vat = row.get("effectiveVat") if row.get("effectiveVat") is not None else row.get("vat")
	return f"{cint(vat)}%" if vat is not None else "Без НДС"


def _tracking_method(value):
	value = str(value or "").upper()
	if "SERIAL" in value:
		return "Serial"
	if value and value not in ("NOT_TRACKED", "NONE"):
		return "Batch"
	return "None"


def _supplier_type(value):
	return {"individual": "Individual", "entrepreneur": "Individual Entrepreneur"}.get(str(value or "").lower(), "Company")


def _load_json(value):
	try:
		return json.loads(value) if value else None
	except (TypeError, ValueError):
		return None


def _dump(value):
	return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _has_token(doc):
	return bool(doc.get_password("access_token", raise_exception=False))


def _validated_interval(value):
	try:
		interval = int(value or 60)
	except (TypeError, ValueError):
		frappe.throw(_("Некорректный интервал синхронизации"))
	return max(MIN_SYNC_INTERVAL, min(interval, MAX_SYNC_INTERVAL))


def _sync_is_due(doc):
	if not doc.last_checked_at:
		return True
	return (now_datetime() - get_datetime(doc.last_checked_at)).total_seconds() >= _validated_interval(doc.sync_interval_minutes) * 60


def _active_rows(rows, stats):
	active = []
	for row in rows:
		if row.get("archived"):
			stats["archived_skipped"] += 1
			continue
		active.append(row)
	return active


def _save_preview(doc, result):
	doc.status = "Connected"
	doc.account_name = result.get("account_name")
	doc.last_checked_at = now_datetime()
	doc.last_error = None
	doc.last_preview_json = json.dumps(result, ensure_ascii=False)
	doc.save(ignore_permissions=True)


def _update_status(doc, status, account_name=None, error_message=None):
	doc.status = status
	doc.last_checked_at = now_datetime()
	if account_name is not None:
		doc.account_name = account_name
	doc.last_error = error_message
	doc.save(ignore_permissions=True)


def _commit_periodically(count):
	if count and count % 100 == 0:
		frappe.db.commit()
