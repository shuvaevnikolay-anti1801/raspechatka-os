from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

import frappe
from frappe import _
from frappe.utils import flt, getdate, nowdate


def get_default_price_type(business_point):
	"""Return the active selling price type configured for a point."""
	price_type = frappe.db.get_value("Business Point", business_point, "default_price_type")
	if price_type and frappe.db.exists("Catalog Price Type", {"name": price_type, "active": 1, "purpose": "Selling"}):
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
		["active", "stock_uom"],
		as_dict=True,
	)
	if not item_row or not item_row.active:
		frappe.throw(_("Позиция каталога недоступна."))

	point = frappe.db.get_value(
		"Business Point",
		business_point,
		["active", "price_rounding", "allow_free_price"],
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
		if required:
			frappe.throw(
				_("Для позиции «{0}» не настроена действующая цена «{1}».").format(item, price_type)
			)
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


def round_price(rate, rule):
	value = Decimal(str(rate))
	if rule == "До 1 рубля":
		return float(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
	if rule == "До 10 рублей":
		return float(\n\t\t\t(value / Decimal("10")).quantize(Decimal("1"), rounding=ROUND_HALF_UP) * Decimal("10")\n\t\t)
	return float(value)
