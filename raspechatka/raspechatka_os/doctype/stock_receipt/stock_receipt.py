import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, now_datetime


class StockReceipt(Document):
	def before_insert(self):
		self.posting_datetime = self.posting_datetime or now_datetime()

	def validate(self):
		self._validate_header()
		self._validate_items()
		self.total_quantity = sum(flt(row.quantity) for row in self.items)
		self.total_amount = sum(flt(row.amount) for row in self.items)

	def on_submit(self):
		self._make_ledger_entries()

	def on_cancel(self):
		self._make_ledger_entries(reversal=True)

	def _validate_header(self):
		if self.receipt_type == "Приёмка" and not self.supplier:
			frappe.throw(_("Для приёмки укажите поставщика."))
		if self.receipt_type == "Оприходование" and not (self.reason or "").strip():
			frappe.throw(_("Для оприходования укажите основание."))
		if frappe.db.get_value("Business Point", self.business_point, "business_entity") != self.business_entity:
			frappe.throw(_("Точка продаж не относится к выбранному юридическому лицу."))
		if frappe.db.get_value("Catalog Warehouse", self.warehouse, "business_point") != self.business_point:
			frappe.throw(_("Склад не относится к выбранной точке продаж."))

	def _validate_items(self):
		if not self.items:
			frappe.throw(_("Добавьте хотя бы один товар."))
		seen = set()
		for row in self.items:
			item = frappe.db.get_value(
				"Catalog Item", row.item, ["item_code", "item_type", "stock_uom", "track_inventory", "active"], as_dict=True
			)
			if not item or item.item_type != "Product" or not item.track_inventory or not item.active:
				frappe.throw(_("В складской документ можно добавить только активный товар с учётом остатков."))
			row.item_code = item.item_code
			row.uom = row.uom or item.stock_uom
			if flt(row.quantity) <= 0:
				frappe.throw(_("Количество товара должно быть больше нуля."))
			if flt(row.rate) <= 0:
				frappe.throw(_("Закупочная цена обязательна и должна быть больше нуля."))
			if not row.storage_location:
				row.storage_location = frappe.db.get_value(
					"Catalog Item Storage", {"item": row.item, "warehouse": self.warehouse, "active": 1}, "storage_location"
				)
			if row.storage_location:
				location_warehouse = frappe.db.get_value("Storage Location", row.storage_location, "warehouse")
				if location_warehouse != self.warehouse:
					frappe.throw(_("Место хранения должно относиться к складу документа."))
			key = (row.item, row.storage_location or "")
			if key in seen:
				frappe.throw(_("Одинаковый товар и место хранения указаны дважды."))
			seen.add(key)
			row.amount = flt(row.quantity) * flt(row.rate)

	def _make_ledger_entries(self, reversal=False):
		for row in self.items:
			entry = frappe.new_doc("Stock Ledger Entry")
			entry.posting_datetime = now_datetime() if reversal else self.posting_datetime
			entry.item = row.item
			entry.warehouse = self.warehouse
			entry.storage_location = row.storage_location
			entry.actual_qty = -flt(row.quantity) if reversal else flt(row.quantity)
			entry.incoming_rate = flt(row.rate)
			entry.stock_value_difference = -flt(row.amount) if reversal else flt(row.amount)
			entry.voucher_type = self.doctype
			entry.voucher_no = self.name
			entry.voucher_detail_no = row.name
			entry.is_reversal = 1 if reversal else 0
			entry.insert(ignore_permissions=True)
