# ruff: noqa: RUF001
"""Current point-specific Catalog Item cost resolution.

Warehouse moving-average valuation remains owned by ``raspechatka.stock``.
This module translates that physical valuation into the business cost of a
sellable Product, Variant, Service, or Bundle without persisting derived cost.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import flt

from raspechatka.stock import get_warehouse_average_rates

PHYSICAL_TYPES = {"Product", "Variant"}


def get_point_item_costs(items, business_point):
	"""Resolve current Catalog Item costs in batches for one Business Point.

	The caller is responsible for access/scope validation at its API boundary.
	The point's single active warehouse is resolved here and is never trusted
	from frontend input.
	"""
	requested = list(dict.fromkeys(filter(None, items or [])))
	if not requested:
		return {}

	warehouse = _point_warehouse(business_point)
	item_rows = frappe.get_all(
		"Catalog Item",
		filters={"name": ["in", requested]},
		fields=["name", "item_name", "item_type"],
		limit_page_length=0,
	)
	by_name = {row.name: row for row in item_rows}
	bundle_names = [row.name for row in item_rows if row.item_type == "Bundle"]
	components = (
		frappe.get_all(
			"Catalog Bundle Component",
			filters={"parent": ["in", bundle_names]},
			fields=["parent", "item", "quantity", "idx"],
			order_by="parent asc, idx asc",
			limit_page_length=0,
		)
		if bundle_names
		else []
	)
	component_names = list(dict.fromkeys(row.item for row in components if row.item))
	missing_component_names = [name for name in component_names if name not in by_name]
	if missing_component_names:
		component_rows = frappe.get_all(
			"Catalog Item",
			filters={"name": ["in", missing_component_names]},
			fields=["name", "item_name", "item_type"],
			limit_page_length=0,
		)
		by_name.update({row.name: row for row in component_rows})

	physical_names = [name for name, row in by_name.items() if row.item_type in PHYSICAL_TYPES]
	physical_costs = get_warehouse_average_rates(physical_names, warehouse)
	resolved = {}
	for name, row in by_name.items():
		if row.item_type in PHYSICAL_TYPES:
			resolved[name] = _physical_cost(row, physical_costs.get(name), warehouse)
		elif row.item_type == "Service":
			resolved[name] = _available(name, 0, "service", row.item_type, warehouse)

	components_by_bundle = {}
	for component in components:
		components_by_bundle.setdefault(component.parent, []).append(component)
	for bundle in bundle_names:
		resolved[bundle] = _bundle_cost(
			by_name[bundle], components_by_bundle.get(bundle, []), by_name, resolved, warehouse
		)

	for name in requested:
		if name not in by_name:
			resolved[name] = _unavailable(
				name, "item_not_found", _("Позиция каталога не найдена."), None, warehouse
			)
		elif name not in resolved:
			resolved[name] = _unavailable(
				name,
				"unsupported_item_type",
				_("Тип позиции не поддерживает расчёт себестоимости."),
				by_name[name].item_type,
				warehouse,
			)
	return {name: resolved[name] for name in requested}


def _point_warehouse(business_point):
	warehouses = frappe.get_all(
		"Catalog Warehouse",
		filters={"business_point": business_point, "active": 1},
		pluck="name",
		limit_page_length=2,
	)
	if len(warehouses) != 1:
		frappe.throw(
			_("Для точки должен быть настроен ровно один активный рабочий склад."),
			frappe.ValidationError,
		)
	return warehouses[0]


def _physical_cost(item, rate, warehouse):
	if rate is None:
		return _unavailable(
			item.name,
			"stock_valuation_unavailable",
			_("Нет актуальной складской оценки в рабочем складе точки."),
			item.item_type,
			warehouse,
		)
	return _available(item.name, rate, "stock_balance", item.item_type, warehouse)


def _bundle_cost(bundle, components, items, resolved, warehouse):
	if not components:
		return _unavailable(
			bundle.name,
			"bundle_empty",
			_("В комплекте нет компонентов для расчёта себестоимости."),
			bundle.item_type,
			warehouse,
		)
	total = 0
	for component in components:
		component_item = items.get(component.item)
		if not component_item:
			return _bundle_component_unavailable(bundle, component.item, "component_not_found", warehouse)
		if component_item.item_type == "Bundle":
			return _bundle_component_unavailable(bundle, component.item, "nested_bundle", warehouse)
		component_cost = resolved.get(component.item)
		if not component_cost or component_cost["cost"] is None:
			return _bundle_component_unavailable(
				bundle,
				component.item,
				(component_cost or {}).get("reason", "component_cost_unavailable"),
				warehouse,
				component_item.item_name,
			)
		total += flt(component_cost["cost"]) * flt(component.quantity)
	return _available(bundle.name, total, "bundle_components", bundle.item_type, warehouse)


def _bundle_component_unavailable(bundle, component, reason, warehouse, component_label=None):
	label = component_label or component
	return _unavailable(
		bundle.name,
		"bundle_incomplete",
		_("Не удалось рассчитать компонент «{0}»: {1}.").format(label, _reason_label(reason)),
		bundle.item_type,
		warehouse,
		{"component": component, "component_reason": reason},
	)


def _reason_label(reason):
	return {
		"nested_bundle": _("вложенные комплекты не поддерживаются"),
		"component_not_found": _("позиция не найдена"),
		"stock_valuation_unavailable": _("нет складской оценки"),
		"component_cost_unavailable": _("себестоимость недоступна"),
	}.get(reason, _("себестоимость недоступна"))


def _available(item, cost, source, item_type, warehouse):
	return {
		"item": item,
		"cost": flt(cost),
		"status": "available",
		"source": source,
		"type": item_type,
		"reason": None,
		"reason_message": None,
		"warehouse": warehouse,
	}


def _unavailable(item, reason, message, item_type, warehouse, details=None):
	return {
		"item": item,
		"cost": None,
		"status": "unavailable",
		"source": None,
		"type": item_type,
		"reason": reason,
		"reason_message": message,
		"warehouse": warehouse,
		**(details or {}),
	}
