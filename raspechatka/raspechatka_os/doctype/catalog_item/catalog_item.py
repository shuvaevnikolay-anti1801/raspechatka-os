# Copyright (c) 2026, Raspechatka and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class CatalogItem(Document):
	def validate(self):
		self._clean_identifiers()
		self._apply_type_rules()
		self._validate_rows()

	def _clean_identifiers(self):
		self.item_code = (self.item_code or "").strip()
		self.item_name = (self.item_name or "").strip()
		self.article = (self.article or "").strip() or None
		self.external_code = (self.external_code or "").strip() or None

	def _apply_type_rules(self):
		if self.item_type in {"Service", "Bundle"}:
			self.track_inventory = 0

		if self.item_type == "Service":
			self.set("bundle_components", [])
			self.set("reorder_rules", [])

		if self.item_type == "Product":
			self.set("bundle_components", [])

		if self.item_type == "Bundle" and not self.bundle_components:
			frappe.throw(_("Добавьте хотя бы один товар в состав комплекта."))

	def _validate_rows(self):
		barcodes = set()
		for row in self.barcodes:
			row.barcode = (row.barcode or "").strip()
			if row.barcode in barcodes:
				frappe.throw(_("Штрихкод {0} указан в карточке дважды.").format(row.barcode))
			barcodes.add(row.barcode)

		for row in self.prices:
			if row.rate is not None and row.rate < 0:
				frappe.throw(_("Цена не может быть отрицательной."))
			if row.valid_from and row.valid_upto and row.valid_from > row.valid_upto:
				frappe.throw(_("Дата окончания цены не может быть раньше даты начала."))

		for row in self.bundle_components:
			if row.item == self.name:
				frappe.throw(_("Комплект не может включать сам себя."))
			if not row.quantity or row.quantity <= 0:
				frappe.throw(_("Количество компонента комплекта должно быть больше нуля."))

		for row in self.packaging:
			if not row.quantity or row.quantity <= 0:
				frappe.throw(_("Количество в упаковке должно быть больше нуля."))

