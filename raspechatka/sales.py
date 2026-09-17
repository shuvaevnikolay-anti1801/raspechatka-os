from collections import defaultdict

import frappe
from frappe.utils import flt, now_datetime


def log_cashier_action(document, action_type, external_id=None, details=None, metric_value=1, gift_tier=None):
	if external_id and frappe.db.exists("Cashier Action", {"external_id": external_id}):
		return
	action = frappe.new_doc("Cashier Action")
	action.external_id = external_id
	action.action_datetime = getattr(document, "posting_datetime", None) or getattr(document, "opened_at", None) or now_datetime()
	action.action_type = action_type
	action.business_entity = document.business_entity
	action.business_point = document.business_point
	action.shift = document.name if document.doctype == "Sales Shift" else document.shift
	action.cashier = getattr(document, "cashier", None)
	action.metric_value = metric_value or 1
	action.gift_tier = gift_tier
	action.reference_doctype = document.doctype
	action.reference_document = document.name
	action.details = details
	action.insert(ignore_permissions=True)


def update_shift_totals(shift_name):
	if not shift_name or not frappe.db.exists("Sales Shift", shift_name):
		return
	receipts = frappe.get_all("Sales Receipt", filters={"shift": shift_name, "docstatus": 1}, fields=["receipt_type", "gross_amount", "discount_amount", "review_discount_amount", "other_discount_amount", "total_amount"], limit_page_length=100000)
	payments = frappe.get_all("Sales Receipt Payment", filters={"parent": ["in", frappe.get_all("Sales Receipt", filters={"shift": shift_name, "docstatus": 1}, pluck="name") or ["__none__"]]}, fields=["parent", "payment_channel", "amount"], limit_page_length=100000)
	receipt_types = {row.name: row.receipt_type for row in frappe.get_all("Sales Receipt", filters={"shift": shift_name, "docstatus": 1}, fields=["name", "receipt_type"], limit_page_length=100000)}
	movements = frappe.get_all("Cash Movement", filters={"shift": shift_name, "docstatus": 1}, fields=["movement_type", "amount"], limit_page_length=100000)
	actions = frappe.get_all("Cashier Action", filters={"shift": shift_name, "action_type": ["in", ["REVIEW_RECEIVED", "CLUB_REGISTRATION", "GIFT_ORDER"]]}, fields=["action_type", "metric_value", "gift_tier"], limit_page_length=100000)
	sales = [r for r in receipts if r.receipt_type == "Sale"]
	returns = [r for r in receipts if r.receipt_type == "Return"]
	channels = defaultdict(float)
	for row in payments:
		sign = -1 if receipt_types.get(row.parent) == "Return" else 1
		channels[row.payment_channel] += sign * flt(row.amount)
	deposits = sum(flt(r.amount) for r in movements if r.movement_type == "Deposit")
	withdrawals = sum(flt(r.amount) for r in movements if r.movement_type == "Withdrawal")
	metrics = defaultdict(int)
	gifts = defaultdict(int)
	for row in actions:
		metrics[row.action_type] += int(row.metric_value or 1)
		if row.action_type == "GIFT_ORDER" and row.gift_tier:
			gifts[row.gift_tier] += int(row.metric_value or 1)
	shift = frappe.db.get_value("Sales Shift", shift_name, ["opening_cash"], as_dict=True)
	values = {
		"receipt_count": len(sales), "sale_count": len(sales), "return_count": len(returns),
		"gross_sales": sum(flt(r.total_amount) for r in sales), "returns_total": sum(flt(r.total_amount) for r in returns),
		"sales_before_discount": sum(flt(r.gross_amount) for r in sales), "discounts_total": sum(flt(r.discount_amount) for r in sales),
		"review_discounts": sum(flt(r.review_discount_amount) for r in sales), "other_discounts": sum(flt(r.other_discount_amount) for r in sales),
		"discounted_receipt_count": sum(1 for r in sales if flt(r.discount_amount) > 0),
		"cash_sales": channels["Cash"], "card_sales": channels["Card"], "qr_sales": channels["QR"],
		"reviews_count": metrics["REVIEW_RECEIVED"], "club_registrations": metrics["CLUB_REGISTRATION"], "gift_orders": metrics["GIFT_ORDER"],
		"gift_orders_1": gifts["GIFT_1"], "gift_orders_2": gifts["GIFT_2"], "gift_orders_3": gifts["GIFT_3"],
	}
	values["net_sales"] = values["gross_sales"] - values["returns_total"]
	values["average_check"] = values["sales_before_discount"] / len(sales) if sales else 0
	values["discount_conversion"] = values["discounted_receipt_count"] / len(sales) * 100 if sales else 0
	values["expected_cash"] = flt(shift.opening_cash) + channels["Cash"] + deposits - withdrawals
	frappe.db.set_value("Sales Shift", shift_name, values, update_modified=False)
