import json
from urllib.parse import urljoin

import frappe
import requests
from frappe import _
from frappe.utils import get_datetime, now_datetime

from raspechatka.access import require_access


API_BASE = "https://api.moysklad.ru/api/remap/1.2/"
DEFAULT_TIMEOUT = 20
MIN_SYNC_INTERVAL = 15
MAX_SYNC_INTERVAL = 1440

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


@frappe.whitelist()
def get_settings():
	require_access("settings.access", "admin")
	doc = frappe.get_single("MoySklad Settings")
	return _safe_settings(doc)


@frappe.whitelist(methods=["POST"])
def save_settings(data):
	require_access("settings.access", "admin")
	data = frappe.parse_json(data) or {}
	doc = frappe.get_single("MoySklad Settings")
	doc.enabled = 1 if data.get("enabled") else 0
	doc.sync_interval_minutes = _validated_interval(data.get("sync_interval_minutes"))
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


def sync_enabled_connection():
	"""Refresh source metadata on schedule. This stage never writes master data."""
	try:
		doc = frappe.get_single("MoySklad Settings")
	except frappe.DoesNotExistError:
		return
	if not doc.enabled or not _has_token(doc) or not _sync_is_due(doc):
		return
	try:
		_save_preview(doc, _collect_preview(doc))
	except MoySkladRequestError as exc:
		_update_status(doc, "Error", error_message=str(exc))


def _collect_preview(doc):
	employee = _request(doc, "context/employee")
	rows = []
	for code, label, target, endpoint in SOURCES:
		try:
			payload = _request(doc, endpoint, params={"limit": 3})
			meta = payload.get("meta") or {}
			samples = [row.get("name") for row in payload.get("rows") or [] if row.get("name")]
			rows.append({
				"code": code,
				"label": label,
				"target": target,
				"count": int(meta.get("size") or len(payload.get("rows") or [])),
				"samples": samples,
				"available": True,
				"error": None,
			})
		except MoySkladRequestError as exc:
			if exc.status_code in (401, 429):
				raise
			rows.append({
				"code": code,
				"label": label,
				"target": target,
				"count": None,
				"samples": [],
				"available": False,
				"error": str(exc),
			})
	return {
		"mode": "preview",
		"writes": 0,
		"account_name": employee.get("name") or employee.get("email"),
		"read_at": str(now_datetime()),
		"sources": rows,
	}


def _request(doc, endpoint, params=None):
	token = doc.get_password("access_token", raise_exception=False)
	if not token:
		raise MoySkladRequestError(_("Сохраните токен МоегоСклада"))
	try:
		response = requests.get(
			urljoin(API_BASE, endpoint),
			headers={
				"Authorization": f"Bearer {token}",
				"Accept-Encoding": "gzip",
				"User-Agent": "Raspechatka-OS/1.0",
			},
			params=params,
			timeout=DEFAULT_TIMEOUT,
		)
	except requests.Timeout as exc:
		raise MoySkladRequestError(_("МойСклад не ответил за отведённое время")) from exc
	except requests.RequestException as exc:
		raise MoySkladRequestError(_("Не удалось соединиться с МоимСкладом")) from exc
	if not response.ok:
		messages = {
			401: _("Токен МоегоСклада недействителен"),
			403: _("У токена нет доступа к этим данным МоегоСклада"),
			404: _("Раздел данных не поддерживается аккаунтом МоегоСклада"),
			429: _("МойСклад временно ограничил число запросов. Повторите позже"),
		}
		message = messages.get(response.status_code, _("МойСклад вернул ошибку {0}").format(response.status_code))
		raise MoySkladRequestError(message, response.status_code)
	try:
		return response.json()
	except ValueError as exc:
		raise MoySkladRequestError(_("МойСклад вернул некорректный ответ")) from exc


def _safe_settings(doc):
	preview = None
	if doc.last_preview_json:
		try:
			preview = json.loads(doc.last_preview_json)
		except (TypeError, ValueError):
			preview = None
	return {
		"enabled": bool(doc.enabled),
		"sync_interval_minutes": int(doc.sync_interval_minutes or 60),
		"status": doc.status or "Not configured",
		"account_name": doc.account_name,
		"last_checked_at": doc.last_checked_at,
		"last_error": doc.last_error,
		"has_token": _has_token(doc),
		"api_base": API_BASE.rstrip("/"),
		"preview": preview,
		"import_enabled": False,
	}


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
	elapsed = now_datetime() - get_datetime(doc.last_checked_at)
	return elapsed.total_seconds() >= _validated_interval(doc.sync_interval_minutes) * 60


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
