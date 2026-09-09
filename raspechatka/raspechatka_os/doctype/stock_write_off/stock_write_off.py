import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, now_datetime

from raspechatka.stock import get_average_rate, get_balance, get_item, make_ledger_entry, validate_chronology, validate_location, validate_warehouse_header


class StockWriteOff(Document):
	def before_insert(self):
		self.posting_datetime = self.posting_datetime or now_datetime()

	def validate(self):
		validate_warehouse_header(self.business_entity, self.business_point, self.warehouse)
		if not (self.reason or "").strip():
			frappe.throw(_("Укажите причину списания."))
		if not self.items:
			frappe.throw(_("Добавьте хотя бы один товар."))
		requested = {}
		requested_total = {}
		for row in self.items:
			item = get_item(row.item, allow_inactive=self.source == "MoySklad")
			row.item_code, row.uom = item.item_code, row.uom or item.stock_uom
			validate_location(row.storage_location, self.warehouse)
			if flt(row.quantity) <= 0:
				frappe.throw(_("Количество списания должно быть больше нуля."))
			row.valuation_rate = get_average_rate(row.item, self.warehouse, self.posting_datetime)
			row.amount = flt(row.quantity) * flt(row.valuation_rate)
			key = (row.item, row.storage_location or "")
			requested[key] = requested.get(key, 0) + flt(row.quantity)
			requested_total[row.item] = requested_total.get(row.item, 0) + flt(row.quantity)
			if not item.allow_negative_stock:
				available = get_balance(row.item, self.warehouse, row.storage_location, self.posting_datetime)["qty"]
				if requested[key] > available:
					frappe.throw(_("Недостаточно остатка товара {0}: доступно {1}.").format(item.item_name, available))
				warehouse_available = get_balance(row.item, self.warehouse, posting_datetime=self.posting_datetime)["qty"]
				if requested_total[row.item] > warehouse_available:
					frappe.throw(_("Недостаточно общего остатка товара {0}: доступно {1}.").format(item.item_name, warehouse_available))
		self.total_quantity = sum(flt(row.quantity) for row in self.items)
		self.total_amount = sum(flt(row.amount) for row in self.items)

	def on_submit(self):
		for row in self.items:
			make_ledger_entry(self, row, -flt(row.quantity), row.valuation_rate, -flt(row.amount))

	def before_submit(self):
		validate_chronology(self.warehouse, self.posting_datetime)

	def on_cancel(self):
		for row in self.items:
			make_ledger_entry(self, row, -flt(row.quantity), row.valuation_rate, -flt(row.amount), reversal=True)
