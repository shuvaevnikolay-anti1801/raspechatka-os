# ruff: noqa: RUF001
"""Transactional point-price tools used by the Web OS price workspace."""

from __future__ import annotations

import hashlib
import json
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP, Decimal

import frappe
from frappe import _
from frappe.utils import cint, flt

from raspechatka.access import require_access
from raspechatka.access_contract import access_contract
from raspechatka.api.catalog_layers import _ensure_point
from raspechatka.api.frontend import _catalog_group_branch
from raspechatka.costing import get_point_item_costs
from raspechatka.pricing import resolve_point_prices, set_point_price

MAX_BULK_ITEMS = 5000


def _items(point, catalog_group=None):
	filters = {"business_point": point, "enabled": 1}
	item_names = frappe.get_all(
		"Catalog Assortment", filters=filters, pluck="item", limit_page_length=MAX_BULK_ITEMS + 1
	)
	if len(item_names) > MAX_BULK_ITEMS:
		frappe.throw(_("За одну операцию можно изменить не более {0} позиций.").format(MAX_BULK_ITEMS))
	item_filters = {"name": ["in", item_names or ["__none__"]], "active": 1}
	if catalog_group:
		item_filters["catalog_group"] = ["in", _catalog_group_branch(catalog_group)]
	return frappe.get_all(
		"Catalog Item",
		filters=item_filters,
		fields=["name", "item_name", "stock_uom"],
		order_by="item_name asc",
		limit_page_length=MAX_BULK_ITEMS,
	)


def _token(kind, point, payload, rows):
	data = {
		"kind": kind,
		"point": point,
		"payload": payload,
		"rows": [
			[
				row["item"],
				row.get("cost"),
				row.get("current_rate"),
				row.get("new_rate"),
				row.get("status"),
			]
			for row in rows
		],
	}
	return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()


def _summary(rows):
	return {
		"total": len(rows),
		"changed": sum(row["status"] == "changed" for row in rows),
		"skipped": sum(row["status"] == "skipped" for row in rows),
		"unchanged": sum(row["status"] == "unchanged" for row in rows),
	}


def _markup(rate, cost):
	if rate is None or cost is None or flt(cost) <= 0:
		return None
	return (flt(rate) - flt(cost)) / flt(cost) * 100


def _markup_status(rate, cost):
	if cost is None:
		return "unavailable"
	if flt(cost) == 0:
		return "infinite" if rate is not None and flt(rate) > 0 else "zero"
	return "percent"


def _lock_scope_items(point, catalog_group=None):
	for item in _items(point, catalog_group):
		frappe.db.sql("select name from `tabCatalog Item` where name=%s for update", item.name)


def _copy_preview(target_point, source_point, catalog_group=None):
	items = _items(target_point, catalog_group)
	names = [row.name for row in items]
	source = resolve_point_prices(names, source_point)
	target = resolve_point_prices(names, target_point)
	costs = get_point_item_costs(names, target_point)
	rows = []
	for item in items:
		old = target.get(item.name)
		new = source.get(item.name)
		cost_result = costs[item.name]
		cost = cost_result["cost"]
		status = "skipped" if not new else "unchanged" if old and old["rate"] == new["rate"] else "changed"
		rows.append(
			{
				"item": item.name,
				"item_name": item.item_name,
				"current_rate": old["rate"] if old else None,
				"new_rate": new["rate"] if new else None,
				"cost": cost,
				"cost_status": cost_result["status"],
				"cost_reason": cost_result["reason"],
				"cost_reason_message": cost_result["reason_message"],
				"current_markup": _markup(old["rate"] if old else None, cost),
				"new_markup": _markup(new["rate"] if new else None, cost),
				"current_markup_status": _markup_status(old["rate"] if old else None, cost),
				"new_markup_status": _markup_status(new["rate"] if new else None, cost),
				"status": status,
				"reason": _("В точке-источнике цена не задана") if not new else None,
			}
		)
	payload = {"source_point": source_point, "catalog_group": catalog_group or ""}
	return rows, payload


@frappe.whitelist()
@access_contract(area="page.catalog.prices", action="read", scope="point")
def preview_copy_prices(business_point, source_point, catalog_group=None):
	require_access("page.catalog.prices", "read")
	target = _ensure_point(business_point)
	source = _ensure_point(source_point)
	if target == source:
		frappe.throw(_("Выберите другую точку-источник."))
	rows, payload = _copy_preview(target, source, catalog_group)
	return {"rows": rows, "summary": _summary(rows), "token": _token("copy", target, payload, rows)}


@frappe.whitelist(methods=["POST"])
@access_contract(area="page.catalog.prices", action="write", scope="point")
def apply_copy_prices(business_point, source_point, preview_token, catalog_group=None):
	require_access("page.catalog.prices", "write")
	target = _ensure_point(business_point)
	source = _ensure_point(source_point)
	_lock_scope_items(target, catalog_group)
	rows, payload = _copy_preview(target, source, catalog_group)
	if preview_token != _token("copy", target, payload, rows):
		frappe.throw(_("Цены изменились после предпросмотра. Обновите предпросмотр и повторите."))
	for row in rows:
		if row["status"] == "changed":
			set_point_price(row["item"], target, row["new_rate"])
	return {"updated": _summary(rows)["changed"]}


def _decimal(value, label):
	try:
		result = Decimal(str(value))
	except Exception:
		frappe.throw(_("Поле «{0}» должно быть числом.").format(label))
	if not result.is_finite():
		frappe.throw(_("Поле «{0}» должно быть конечным числом.").format(label))
	return result


def calculate_price(current_rate, cost, spec):
	"""Pure calculator used by preview, apply and unit tests."""
	mode = spec.get("mode", "change")
	if mode == "markup":
		if cost is None:
			return None, _("Нет расчётной себестоимости")
		if _decimal(cost, "Себестоимость") == 0:
			return None, _("Нельзя установить процентную наценку при нулевой себестоимости")
		value = _decimal(cost, "Себестоимость") * (
			Decimal("1") + _decimal(spec.get("value"), "Наценка") / 100
		)
	else:
		base = cost if spec.get("base") == "cost" else current_rate
		if base is None:
			return None, _("Нет базовой цены")
		base = _decimal(base, "Базовая цена")
		change = _decimal(spec.get("value"), "Изменение")
		if spec.get("unit") == "percent":
			change = base * change / 100
		value = base - change if spec.get("operation") == "subtract" else base + change
	step = _decimal(spec.get("rounding_step") or 0, "Шаг округления")
	if step < 0:
		frappe.throw(_("Шаг округления не может быть отрицательным."))
	if step:
		rounding = {"nearest": ROUND_HALF_UP, "up": ROUND_CEILING, "down": ROUND_FLOOR}.get(
			spec.get("rounding_mode"), ROUND_HALF_UP
		)
		value = (value / step).quantize(Decimal("1"), rounding=rounding) * step
	return max(value, Decimal("0")), None


def _validate_spec(spec):
	allowed = {
		"mode": ("change", "markup"),
		"base": ("current", "cost"),
		"operation": ("add", "subtract"),
		"unit": ("percent", "ruble"),
		"rounding_mode": ("nearest", "up", "down"),
	}
	for key, values in allowed.items():
		if spec.get(key, values[0]) not in values:
			frappe.throw(_("Некорректный параметр калькулятора: {0}.").format(key))
	if _decimal(spec.get("value"), "Значение") < 0:
		frappe.throw(_("Значение изменения не может быть отрицательным."))
	minimum = None
	maximum = None
	if spec.get("min_price") not in (None, ""):
		minimum = _decimal(spec["min_price"], "Минимальная цена")
	if spec.get("max_price") not in (None, ""):
		maximum = _decimal(spec["max_price"], "Максимальная цена")
	if (minimum is not None and minimum < 0) or (maximum is not None and maximum < 0):
		frappe.throw(_("Минимальная и максимальная цены не могут быть отрицательными."))
	if minimum is not None and maximum is not None and minimum > maximum:
		frappe.throw(_("Минимальная цена не может быть больше максимальной."))
	if spec.get("only_markup_below") not in (None, ""):
		_decimal(spec["only_markup_below"], "Наценка ниже")


def _calculator_preview(point, catalog_group, spec):
	items = _items(point, catalog_group)
	names = [row.name for row in items]
	prices = resolve_point_prices(names, point)
	costs = get_point_item_costs(names, point)
	rows = []
	for item in items:
		current = prices.get(item.name)
		current_rate = current["rate"] if current else None
		cost_result = costs[item.name]
		cost = cost_result["cost"]
		status, reason, new_rate = "changed", None, None
		current_markup = _markup(current_rate, cost)
		uses_cost = spec.get("mode") == "markup" or spec.get("base") == "cost"
		if uses_cost and cint(spec.get("skip_without_cost")) and cost is None:
			status, reason = "skipped", _("Нет расчётной себестоимости")
		elif spec.get("only_markup_below") not in (None, "") and (
			current_markup is None or current_markup >= _decimal(spec["only_markup_below"], "Наценка ниже")
		):
			status, reason = "skipped", _("Текущая наценка не ниже условия")
		else:
			new_rate, reason = calculate_price(current_rate, cost, spec)
			if new_rate is None:
				status = "skipped"
			elif cint(spec.get("not_below_cost")) and cost is not None and new_rate < Decimal(str(cost)):
				status, reason = "skipped", _("Цена получилась ниже себестоимости")
			elif spec.get("min_price") not in (None, "") and new_rate < _decimal(
				spec["min_price"], "Минимальная цена"
			):
				status, reason = "skipped", _("Цена ниже заданного минимума")
			elif spec.get("max_price") not in (None, "") and new_rate > _decimal(
				spec["max_price"], "Максимальная цена"
			):
				status, reason = "skipped", _("Цена выше заданного максимума")
			elif current_rate is not None and Decimal(str(current_rate)) == new_rate:
				status = "unchanged"
		new_rate = flt(new_rate) if new_rate is not None else None
		rows.append(
			{
				"item": item.name,
				"item_name": item.item_name,
				"cost": cost,
				"cost_status": cost_result["status"],
				"cost_reason": cost_result["reason"],
				"cost_reason_message": cost_result["reason_message"],
				"current_rate": current_rate,
				"new_rate": new_rate,
				"current_markup": current_markup,
				"new_markup": _markup(new_rate, cost),
				"current_markup_status": _markup_status(current_rate, cost),
				"new_markup_status": _markup_status(new_rate, cost),
				"status": status,
				"reason": reason,
			}
		)
	payload = {"catalog_group": catalog_group or "", "spec": spec}
	return rows, payload


@frappe.whitelist()
@access_contract(area="page.catalog.prices", action="read", scope="point")
def preview_calculated_prices(business_point, spec, catalog_group=None):
	require_access("page.catalog.prices", "read")
	point = _ensure_point(business_point)
	spec = frappe.parse_json(spec) or {}
	_validate_spec(spec)
	rows, payload = _calculator_preview(point, catalog_group, spec)
	return {"rows": rows, "summary": _summary(rows), "token": _token("calculator", point, payload, rows)}


@frappe.whitelist(methods=["POST"])
@access_contract(area="page.catalog.prices", action="write", scope="point")
def apply_calculated_prices(business_point, spec, preview_token, catalog_group=None):
	require_access("page.catalog.prices", "write")
	point = _ensure_point(business_point)
	spec = frappe.parse_json(spec) or {}
	_validate_spec(spec)
	_lock_scope_items(point, catalog_group)
	rows, payload = _calculator_preview(point, catalog_group, spec)
	if preview_token != _token("calculator", point, payload, rows):
		frappe.throw(_("Цены изменились после предпросмотра. Обновите предпросмотр и повторите."))
	for row in rows:
		if row["status"] == "changed":
			set_point_price(row["item"], point, row["new_rate"])
	return {"updated": _summary(rows)["changed"]}
