# ruff: noqa: RUF001

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, now_datetime

from raspechatka.stock import make_ledger_entry, validate_chronology


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
		self._update_purchase_order()

	def before_submit(self):
		if not self.flags.ignore_stock_chronology:
			validate_chronology(self.warehouse, self.posting_datetime)

	def on_cancel(self):
		self._make_ledger_entries(reversal=True)
		self._update_purchase_order()

	def _validate_header(self):
		if self.receipt_type == "Приёмка" and not self.supplier:
			frappe.throw(_("Для приёмки укажите поставщика."))
		if self.receipt_type == "Оприходование" and not (self.reason or "").strip():
			frappe.throw(_("Для оприходования укажите основание."))
		if (
			frappe.db.get_value("Business Point", self.business_point, "business_entity")
			!= self.business_entity
		):
			frappe.throw(_("Точка продаж не относится к выбранному юридическому лицу."))
		if frappe.db.get_value("Catalog Warehouse", self.warehouse, "business_point") != self.business_point:
			frappe.throw(_("Склад не относится к выбранной точке продаж."))
		if self.purchase_order:
			order = frappe.db.get_value(
				"Purchase Order",
				self.purchase_order,
				["docstatus", "business_entity", "business_point", "warehouse", "supplier"],
				as_dict=True,
			)
			if not order or order.docstatus != 1:
				frappe.throw(_("Связанный заказ поставщику должен быть проведён."))
			if (order.business_entity, order.business_point, order.warehouse, order.supplier) != (
				self.business_entity,
				self.business_point,
				self.warehouse,
				self.supplier,
			):
				frappe.throw(_("Поставщик, ИП, точка и склад должны совпадать со связанным заказом."))

	def _validate_items(self):
		if not self.items:
			frappe.throw(_("Добавьте хотя бы один товар."))
		seen = set()
		locations_by_item = {}
		for row in self.items:
			item = frappe.db.get_value(
				"Catalog Item",
				row.item,
				["item_code", "item_type", "stock_uom", "track_inventory", "active"],
				as_dict=True,
			)
			if (
				not item
				or item.item_type not in {"Product", "Variant"}
				or not item.track_inventory
				or (not item.active and self.source != "MoySklad")
			):
				frappe.throw(
					_("В складской документ можно добавить только активный товар с учётом остатков.")
				)
			row.item_code = item.item_code
			row.uom = row.uom or item.stock_uom
			if flt(row.quantity) <= 0:
				frappe.throw(_("Количество товара должно быть больше нуля."))
			if flt(row.rate) <= 0:
				frappe.throw(_("Закупочная цена обязательна и должна быть больше нуля."))
			if not row.storage_location:
				row.storage_location = frappe.db.get_value(
					"Catalog Item Storage",
					{"item": row.item, "warehouse": self.warehouse, "active": 1},
					"storage_location",
				)
			if row.storage_location:
				location_warehouse = frappe.db.get_value(
					"Storage Location", row.storage_location, "warehouse"
				)
				if location_warehouse != self.warehouse:
					frappe.throw(_("Место хранения должно относиться к складу документа."))
			key = (row.item, row.storage_location or "")
			if key in seen:
				frappe.throw(_("Одинаковый товар и место хранения указаны дважды."))
			seen.add(key)
			locations_by_item.setdefault(row.item, set()).add(row.storage_location or "")
			if "" in locations_by_item[row.item] and len(locations_by_item[row.item]) > 1:
				frappe.throw(_("Нельзя одновременно принять товар без адреса и на отдельное место хранения."))
			row.amount = flt(row.quantity) * flt(row.rate)
			if self.purchase_order:
				if not row.purchase_order_item:
					frappe.throw(_("Каждая строка приёмки по заказу должна быть связана со строкой заказа."))
				order_row = frappe.db.get_value(
					"Purchase Order Item",
					row.purchase_order_item,
					["parent", "item", "quantity"],
					as_dict=True,
				)
				if not order_row or order_row.parent != self.purchase_order or order_row.item != row.item:
					frappe.throw(_("Строка приёмки не соответствует связанному заказу поставщику."))
				receipts = frappe.get_all(
					"Stock Receipt",
					filters={
						"purchase_order": self.purchase_order,
						"docstatus": 1,
						"name": ["!=", self.name or ""],
					},
					pluck="name",
				)
				already_received = sum(
					flt(value)
					for value in frappe.get_all(
						"Stock Receipt Item",
						filters={
							"parent": ["in", receipts or ["__none__"]],
							"purchase_order_item": row.purchase_order_item,
						},
						pluck="quantity",
					)
				)
				if already_received + flt(row.quantity) > flt(order_row.quantity):
					frappe.throw(
						_("Количество приёмки превышает остаток по заказу для товара {0}.").format(
							item.item_name
						)
					)

	def _make_ledger_entries(self, reversal=False):
		for row in self.items:
			make_ledger_entry(
				self,
				row,
				flt(row.quantity),
				flt(row.rate),
				flt(row.amount),
				reversal=reversal,
				valuation_source="Purchase receipt" if self.receipt_type == "Приёмка" else "Stock receipt",
			)

	def _update_purchase_order(self):
		if self.purchase_order:
			from raspechatka.raspechatka_os.doctype.purchase_order.purchase_order import (
				update_received_quantities,
			)

			update_received_quantities(self.purchase_order)
