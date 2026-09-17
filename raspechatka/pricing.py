from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from math import isfinite

import frappe
from frappe import _
from frappe.utils import flt, getdate, nowdate


def get_default_price_type(business_point):
	"""Return the active selling price type configured for a point."""
	price_type = frappe.db.get_value("Business Point", business_point, "default_price_type")
	if price_type and frappe.db.exists(
		"Catalog Price Type", {"name": price_type, "active": 1, "purpose": "Selling"}
	):
		return price_type
	return frappe.db.get_value(
		"Catalog Price Type",
		{"active": 1, "purpose": "Selling"},
		"name",
		order_by="creation asc",
	)


def resolve_item_price(
	item,
	business_point,
	quantity=1,
	price_type=None,
	uom=None,
	on_date=None,
	required=True,
):
	"""Resolve one deterministic selling price for every channel and document."""
	item_row = frappe.db.get_value(
		"Catalog Item",
		item,
		["active", "stock_uom", "variant_of"],
		as_dict=True,
	)
	if not item_row or not item_row.active:
		frappe.throw(_("Позиция каталога недоступна."))

	point = frappe.db.get_value(
		"Business Point",
		business_point,
		["active", "price_rounding"],
		as_dict=True,
	)
	if not point or not point.active:
		frappe.throw(_("Точка продаж недоступна."))

	price_type = price_type or get_default_price_type(business_point)
	if not price_type:
		if required:
			frappe.throw(_("Для точки продаж не настроен вид цены."))
		return None

	on_date = getdate(on_date or nowdate())
	quantity = flt(quantity or 1)
	if quantity <= 0:
		frappe.throw(_("Количество должно быть больше нуля."))
	uom = uom or item_row.stock_uom

	rows = frappe.get_all(
		"Catalog Item Price",
		filters={
			"parent": item,
			"parenttype": "Catalog Item",
			"parentfield": "prices",
			"price_type": price_type,
			"minimum_quantity": ["<=", quantity],
		},
		fields=[
			"rate",
			"business_point",
			"uom",
			"currency",
			"minimum_quantity",
			"valid_from",
			"valid_upto",
			"idx",
		],
		limit_page_length=500,
	)
	candidates = [
		row
		for row in rows
		if (not row.business_point or row.business_point == business_point)
		and (not row.uom or row.uom == uom)
		and (not row.valid_from or getdate(row.valid_from) <= on_date)
		and (not row.valid_upto or getdate(row.valid_upto) >= on_date)
	]
	candidates.sort(
		key=lambda row: (
			1 if row.business_point == business_point else 0,
			1 if row.uom == uom else 0,
			flt(row.minimum_quantity or 1),
			getdate(row.valid_from) if row.valid_from else getdate("1900-01-01"),
			row.idx or 0,
		),
		reverse=True,
	)
	if not candidates:
		if item_row.variant_of:
			parent_price = resolve_item_price(
				item_row.variant_of,
				business_point,
				quantity=quantity,
				price_type=price_type,
				uom=uom,
				on_date=on_date,
				required=False,
			)
			if parent_price:
				parent_price["source"] = "Variant Parent"
				parent_price["inherited_from"] = item_row.variant_of
				return parent_price
		if required:
			frappe.throw(_("Для позиции «{0}» не настроена действующая цена «{1}».").format(item, price_type))
		return None

	rate = flt(candidates[0].rate)
	return {
		"rate": round_price(rate, point.price_rounding),
		"price_type": price_type,
		"business_point": candidates[0].business_point,
		"uom": candidates[0].uom or uom,
		"currency": candidates[0].currency or "RUB",
		"source": "Point" if candidates[0].business_point else "Network",
	}


def resolve_item_prices(items, business_point, price_type=None, quantity=1, on_date=None):
	"""Resolve prices for many catalog items without one query per table row."""
	requested = list(dict.fromkeys(items or []))
	if not requested:
		return {}

	point = frappe.db.get_value("Business Point", business_point, ["active", "price_rounding"], as_dict=True)
	if not point or not point.active:
		frappe.throw(_("Точка продаж недоступна."))
	price_type = price_type or get_default_price_type(business_point)
	if not price_type:
		return {item: None for item in requested}
	quantity = flt(quantity or 1)
	if quantity <= 0:
		frappe.throw(_("Количество должно быть больше нуля."))

	item_rows = {}
	pending = list(requested)
	while pending:
		rows = frappe.get_all(
			"Catalog Item",
			filters={"name": ["in", pending], "active": 1},
			fields=["name", "stock_uom", "variant_of"],
			limit_page_length=0,
		)
		pending = []
		for row in rows:
			item_rows[row.name] = row
			if row.variant_of and row.variant_of not in item_rows:
				pending.append(row.variant_of)

	all_items = list(item_rows)
	price_rows = frappe.get_all(
		"Catalog Item Price",
		filters={
			"parent": ["in", all_items or ["__none__"]],
			"parenttype": "Catalog Item",
			"parentfield": "prices",
			"price_type": price_type,
			"minimum_quantity": ["<=", flt(quantity or 1)],
		},
		fields=[
			"parent",
			"rate",
			"business_point",
			"uom",
			"currency",
			"minimum_quantity",
			"valid_from",
			"valid_upto",
			"idx",
		],
		limit_page_length=0,
	)
	rows_by_item = {}
	for row in price_rows:
		rows_by_item.setdefault(row.parent, []).append(row)

	on_date = getdate(on_date or nowdate())
	resolved = {}

	def resolve(item, uom=None, visiting=None):
		item_row = item_rows.get(item)
		uom = uom or (item_row.stock_uom if item_row else None)
		cache_key = (item, uom)
		if cache_key in resolved:
			return resolved[cache_key]
		if not item_row:
			resolved[cache_key] = None
			return None
		candidates = [
			row
			for row in rows_by_item.get(item, [])
			if (not row.business_point or row.business_point == business_point)
			and (not row.uom or row.uom == uom)
			and (not row.valid_from or getdate(row.valid_from) <= on_date)
			and (not row.valid_upto or getdate(row.valid_upto) >= on_date)
		]
		candidates.sort(
			key=lambda row: (
				1 if row.business_point == business_point else 0,
				1 if row.uom == uom else 0,
				flt(row.minimum_quantity or 1),
				getdate(row.valid_from) if row.valid_from else getdate("1900-01-01"),
				row.idx or 0,
			),
			reverse=True,
		)
		if candidates:
			candidate = candidates[0]
			resolved[cache_key] = {
				"rate": round_price(flt(candidate.rate), point.price_rounding),
				"price_type": price_type,
				"business_point": candidate.business_point,
				"uom": candidate.uom or uom,
				"currency": candidate.currency or "RUB",
				"source": "Point" if candidate.business_point else "Network",
			}
			return resolved[cache_key]
		visiting = set(visiting or ())
		if item_row.variant_of and item not in visiting:
			visiting.add(item)
			parent_price = resolve(item_row.variant_of, uom, visiting)
			if parent_price:
				resolved[cache_key] = {
					**parent_price,
					"source": "Variant Parent",
					"inherited_from": item_row.variant_of,
				}
				return resolved[cache_key]
		resolved[cache_key] = None
		return None

	return {item: resolve(item) for item in requested}


def resolve_point_prices(items, business_point, price_type=None, on_date=None):
	"""Return only canonical prices explicitly owned by ``business_point``.

	Network and variant prices remain readable by the legacy resolver solely for
	migration compatibility. Operational Web OS and POS consumers use this
	point-owned contract after the compatibility patch materializes old values.
	"""
	requested = list(dict.fromkeys(items or []))
	if not requested:
		return {}
	point = frappe.db.get_value("Business Point", business_point, ["active", "price_rounding"], as_dict=True)
	if not point or not point.active:
		frappe.throw(_("Точка продаж недоступна."))
	price_type = price_type or get_default_price_type(business_point)
	if not price_type:
		return {item: None for item in requested}
	item_rows = {
		row.name: row
		for row in frappe.get_all(
			"Catalog Item",
			filters={"name": ["in", requested], "active": 1},
			fields=["name", "stock_uom"],
			limit_page_length=0,
		)
	}
	rows = frappe.get_all(
		"Catalog Item Price",
		filters={
			"parent": ["in", requested or ["__none__"]],
			"parenttype": "Catalog Item",
			"parentfield": "prices",
			"business_point": business_point,
			"price_type": price_type,
			"minimum_quantity": ["<=", 1],
		},
		fields=[
			"parent",
			"rate",
			"uom",
			"currency",
			"minimum_quantity",
			"valid_from",
			"valid_upto",
			"idx",
		],
		limit_page_length=0,
	)
	today = getdate(on_date or nowdate())
	by_item = {}
	for row in rows:
		item = item_rows.get(row.parent)
		if not item or (row.uom and row.uom != item.stock_uom):
			continue
		if row.valid_from and getdate(row.valid_from) > today:
			continue
		if row.valid_upto and getdate(row.valid_upto) < today:
			continue
		by_item.setdefault(row.parent, []).append(row)
	result = {}
	for item_name in requested:
		candidates = by_item.get(item_name, [])
		candidates.sort(
			key=lambda row: (
				1 if row.uom == getattr(item_rows.get(item_name), "stock_uom", None) else 0,
				flt(row.minimum_quantity or 1),
				getdate(row.valid_from) if row.valid_from else getdate("1900-01-01"),
				row.idx or 0,
			),
			reverse=True,
		)
		candidate = candidates[0] if candidates else None
		result[item_name] = (
			{
				"rate": round_price(flt(candidate.rate), point.price_rounding),
				"price_type": price_type,
				"business_point": business_point,
				"uom": candidate.uom or getattr(item_rows.get(item_name), "stock_uom", None),
				"currency": candidate.currency or "RUB",
			}
			if candidate
			else None
		)
	return result


def resolve_point_price(item, business_point, price_type=None, required=True):
	price = resolve_point_prices([item], business_point, price_type=price_type).get(item)
	if required and not price:
		frappe.throw(_("Для позиции «{0}» не настроена цена выбранной точки.").format(item))
	return price


def set_point_price(item, business_point, rate, price_type=None, uom=None):
	"""Persist the canonical point price on the existing Catalog Item child table."""
	if not isfinite(flt(rate)) or flt(rate) < 0:
		frappe.throw(_("Цена продажи должна быть неотрицательным конечным числом."))
	doc = frappe.get_doc("Catalog Item", item)
	if not doc.active:
		frappe.throw(_("Позиция каталога недоступна."))
	price_type = price_type or get_default_price_type(business_point)
	if not price_type:
		frappe.throw(_("Для точки продаж не настроен вид цены."))
	uom = uom or doc.stock_uom
	today = getdate(nowdate())
	row = next(
		(
			row
			for row in doc.prices
			if row.business_point == business_point
			and row.price_type == price_type
			and (row.uom or doc.stock_uom) == uom
			and flt(row.minimum_quantity or 1) == 1
			and (not row.valid_from or getdate(row.valid_from) <= today)
			and (not row.valid_upto or getdate(row.valid_upto) >= today)
		),
		None,
	)
	if not row:
		row = doc.append(
			"prices",
			{
				"business_point": business_point,
				"price_type": price_type,
				"uom": uom,
				"currency": "RUB",
				"minimum_quantity": 1,
			},
		)
	row.rate = flt(rate)
	doc.save(ignore_permissions=True)
	return flt(row.rate)


def materialize_legacy_point_prices(items, points):
	"""Idempotently copy current legacy-effective prices into missing point rows."""
	created = 0
	for point in points:
		price_type = get_default_price_type(point)
		point_prices = resolve_point_prices(items, point, price_type=price_type)
		missing = [item for item in items if not point_prices.get(item)]
		legacy = resolve_item_prices(missing, point, price_type=price_type)
		for item in missing:
			price = legacy.get(item)
			if not price:
				continue
			set_point_price(item, point, price["rate"], price_type, price.get("uom"))
			created += 1
	return created


def round_price(rate, rule):
	value = Decimal(str(rate))
	if rule == "До 1 рубля":
		return float(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
	if rule == "До 10 рублей":
		return float((value / Decimal("10")).quantize(Decimal("1"), rounding=ROUND_HALF_UP) * Decimal("10"))
	return float(value)
