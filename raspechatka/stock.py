import frappe
from frappe import _
from frappe.utils import flt, get_datetime, now_datetime


def validate_warehouse_header(business_entity, business_point, warehouse):
	if frappe.db.get_value("Business Point", business_point, "business_entity") != business_entity:
		frappe.throw(_("Точка продаж не относится к выбранному юридическому лицу."))
	if frappe.db.get_value("Catalog Warehouse", warehouse, "business_point") != business_point:
		frappe.throw(_("Склад не относится к выбранной точке продаж."))


def get_item(item_name):
	item = frappe.db.get_value(
		"Catalog Item",
		item_name,
		["item_code", "item_name", "item_type", "stock_uom", "track_inventory", "allow_negative_stock", "active"],
		as_dict=True,
	)
	if not item or item.item_type != "Product" or not item.track_inventory or not item.active:
		frappe.throw(_("В складской документ можно добавить только активный товар с учётом остатков."))
	return item


def validate_location(storage_location, warehouse):
	if storage_location and frappe.db.get_value("Storage Location", storage_location, "warehouse") != warehouse:
		frappe.throw(_("Место хранения должно относиться к складу документа."))


def validate_chronology(warehouse, posting_datetime):
	latest = frappe.db.get_value("Stock Ledger Entry", {"warehouse": warehouse}, "posting_datetime", order_by="posting_datetime desc")
	if latest and get_datetime(posting_datetime) < get_datetime(latest):
		frappe.throw(_("Нельзя провести складской документ раньше уже существующего движения ({0}).").format(latest))


def get_balance(item, warehouse, storage_location=None, posting_datetime=None):
	filters = {"item": item, "warehouse": warehouse}
	if storage_location:
		filters["storage_location"] = storage_location
	if posting_datetime:
		filters["posting_datetime"] = ["<=", posting_datetime]
	rows = frappe.get_all("Stock Ledger Entry", filters=filters, fields=["actual_qty", "stock_value_difference"], limit_page_length=100000)
	return {
		"qty": sum(flt(row.actual_qty) for row in rows),
		"value": sum(flt(row.stock_value_difference) for row in rows),
	}


def get_average_rate(item, warehouse, posting_datetime=None):
	balance = get_balance(item, warehouse, posting_datetime=posting_datetime)
	return flt(balance["value"] / balance["qty"]) if balance["qty"] else 0


def make_ledger_entry(document, row, quantity, rate, amount, reversal=False):
	entry = frappe.new_doc("Stock Ledger Entry")
	entry.posting_datetime = now_datetime() if reversal else document.posting_datetime
	entry.item = row.item
	entry.warehouse = document.warehouse
	entry.storage_location = row.storage_location
	entry.actual_qty = -flt(quantity) if reversal else flt(quantity)
	entry.incoming_rate = flt(rate)
	entry.stock_value_difference = -flt(amount) if reversal else flt(amount)
	entry.voucher_type = document.doctype
	entry.voucher_no = document.name
	entry.voucher_detail_no = row.name
	entry.is_reversal = 1 if reversal else 0
	entry.insert(ignore_permissions=True)
