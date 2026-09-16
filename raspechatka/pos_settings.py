import frappe
from frappe.utils import cint, flt


DEFAULT_POS_SALES_SETTINGS = {
	"allow_free_price": 0,
	"allow_discounts": 1,
	"max_discount_percent": 100,
	"allow_remove_cart_item": 1,
	"accepts_cash": 1,
	"accepts_card": 1,
	"accepts_qr": 1,
}


def get_pos_sales_settings():
	"""Return the network-wide POS rules, including safe defaults before migration."""
	settings = frappe.get_single("POS Sales Settings")
	return {
		"allow_free_price": cint(settings.allow_free_price),
		"allow_discounts": cint(settings.allow_discounts),
		"max_discount_percent": flt(settings.max_discount_percent),
		"allow_remove_cart_item": cint(settings.allow_remove_cart_item),
		"accepts_cash": cint(settings.accepts_cash),
		"accepts_card": cint(settings.accepts_card),
		"accepts_qr": cint(settings.accepts_qr),
	}


def get_pos_sales_rules():
	settings = get_pos_sales_settings()
	return {
		"allowFreePrice": bool(settings["allow_free_price"]),
		"allowRemoveCartItem": bool(settings["allow_remove_cart_item"]),
		"allowDiscounts": bool(settings["allow_discounts"]),
		"maxDiscountPercent": settings["max_discount_percent"],
		"acceptsCash": bool(settings["accepts_cash"]),
		"acceptsCard": bool(settings["accepts_card"]),
		"acceptsQr": bool(settings["accepts_qr"]),
	}
