import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, now_datetime

from raspechatka.stock import (
	get_average_rate,
	get_balance,
	get_item,
	make_ledger_entry,
	validate_chronology,
	validate_location,
	validate_warehouse_header,
)


class StockInventory(Document):
	def before_insert(self):
		self.posting_datetime = self.posting_datetime or now_datetime()

	def validate(self):
		validate_warehouse_header(self.business_entity, self.business_point, self.warehouse)
		if not self.items:
			frappe.throw(_("Добавьте товары или заполните документ по текущим остаткам."))
		seen = set()
		locations_by_item = {}
		for row in self.items:
			item = get_item(row.item, allow_inactive=self.source == "MoySklad Opening Balance")
			row.item_code, row.uom = item.item_code, row.uom or item.stock_uom
			validate_location(row.storage_location, self.warehouse)
			key = (row.item, row.storage_location or "")
			if key in seen:
				frappe.throw(_("Одинаковый товар и место хранения указаны дважды."))
			seen.add(key)
			locations_by_item.setdefault(row.item, set()).add(row.storage_location or "")
			if "" in locations_by_item[row.item] and len(locations_by_item[row.item]) > 1:
				frappe.throw(_("Нельзя одновременно считать товар целиком по складу и по отдельному месту хранения."))
			row.book_quantity = get_balance(row.item, self.warehouse, row.storage_location, self.posting_datetime)["qty"]
			row.difference_quantity = flt(row.counted_quantity) - flt(row.book_quantity)
			current_rate = get_average_rate(row.item, self.warehouse, self.posting_datetime)
			row.valuation_rate = current_rate or flt(row.valuation_rate)
			if row.difference_quantity > 0 and flt(row.valuation_rate) <= 0:
				frappe.throw(_("Для излишка товара {0} укажите себестоимость.").format(item.item_name))
			row.difference_amount = flt(row.difference_quantity) * flt(row.valuation_rate)
		self.total_lines = len(self.items)
		self.surplus_amount = sum(max(flt(row.difference_amount), 0) for row in self.items)
		self.shortage_amount = abs(sum(min(flt(row.difference_amount), 0) for row in self.items))

	def on_submit(self):
		for row in self.items:
			if row.difference_quantity:
				make_ledger_entry(self, row, row.difference_quantity, row.valuation_rate, row.difference_amount)

	def before_submit(self):
		if not self.flags.ignore_stock_chronology:
			validate_chronology(self.warehouse, self.posting_datetime)

	def on_cancel(self):
		for row in self.items:
			if row.difference_quantity:
				make_ledger_entry(self, row, row.difference_quantity, row.valuation_rate, row.difference_amount, reversal=True)
