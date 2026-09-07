# Copyright (c) 2026, Raspechatka and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class CatalogItem(Document):
	def validate(self):
		self._clean_identifiers()
		self._apply_type_rules()
		self._validate_group_and_unit()
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

	def _validate_group_and_unit(self):
		if self.catalog_group and not frappe.db.get_value("Catalog Group", self.catalog_group, "active"):
			frappe.throw(_("Нельзя поместить позицию в архивную группу."))
		if self.stock_uom and not frappe.db.get_value("Catalog Unit", self.stock_uom, "active"):
			frappe.throw(_("Нельзя использовать архивную единицу измерения."))

	def on_trash(self):
		frappe.throw(_("Позиции каталога нельзя удалять. Используйте действие «В архив»."))

	def _bundle_reaches(self, start, target):
		pending = [start]
		seen = set()
		while pending:
			item = pending.pop()
			if item == target:
				return True
			if item in seen:
				continue
			seen.add(item)
			pending.extend(frappe.get_all("Catalog Bundle Component", filters={"parent": item}, pluck="item"))
		return False

	def _validate_rows(self):
		barcodes = set()
		for row in self.barcodes:
			row.barcode = (row.barcode or "").strip()
			if row.barcode in barcodes:
				frappe.throw(_("Штрихкод {0} указан в карточке дважды.").format(row.barcode))
			barcodes.add(row.barcode)
			if row.barcode:
				duplicate = frappe.db.get_value(
					"Catalog Item Barcode",
					{"barcode": row.barcode, "parent": ["!=", self.name or ""]},
					"parent",
				)
				if duplicate:
					frappe.throw(_("Штрихкод {0} уже используется другой позицией.").format(row.barcode))

		price_scopes = {}
		for row in self.prices:
			if not row.minimum_quantity or row.minimum_quantity <= 0:
				frappe.throw(_("Минимальное количество для цены должно быть больше нуля."))
			if row.business_point and not frappe.db.exists("Business Point", {"name": row.business_point, "active": 1}):
				frappe.throw(_("Нельзя использовать неактивную точку в цене."))
			if row.uom and not frappe.db.exists("Catalog Unit", {"name": row.uom, "active": 1}):
				frappe.throw(_("Нельзя использовать неактивную единицу в цене."))
			if not frappe.db.exists("Catalog Price Type", {"name": row.price_type, "active": 1}):
				frappe.throw(_("Нельзя использовать неактивный вид цены."))
			if row.rate is not None and row.rate < 0:
				frappe.throw(_("Цена не может быть отрицательной."))
			if row.valid_from and row.valid_upto and row.valid_from > row.valid_upto:
				frappe.throw(_("Дата окончания цены не может быть раньше даты начала."))

			scope = (\n\t\t\t\trow.price_type,\n\t\t\t\trow.business_point or "",\n\t\t\t\trow.uom or self.stock_uom,\n\t\t\t\trow.currency or "RUB",\n\t\t\t\trow.minimum_quantity,\n\t\t\t)
			for existing_from, existing_upto in price_scopes.get(scope, []):
				if (not existing_upto or not row.valid_from or row.valid_from <= existing_upto) and (
					not row.valid_upto or not existing_from or existing_from <= row.valid_upto
				):
					frappe.throw(_("Периоды одинаковых цен не должны пересекаться."))
			price_scopes.setdefault(scope, []).append((row.valid_from, row.valid_upto))

		component_items = set()
		for row in self.bundle_components:
			if row.item in component_items:
				frappe.throw(_("Компонент {0} указан в комплекте дважды.").format(row.item))
			component_items.add(row.item)
			if not frappe.db.get_value("Catalog Item", row.item, "active"):
				frappe.throw(_("В комплект нельзя добавить архивную позицию."))
			if self.name and self._bundle_reaches(row.item, self.name):
				frappe.throw(_("Обнаружена циклическая связь комплектов."))
			if row.item == self.name:
				frappe.throw(_("Комплект не может включать сам себя."))
			if not row.quantity or row.quantity <= 0:
				frappe.throw(_("Количество компонента комплекта должно быть больше нуля."))

		for row in self.packaging:
			if not row.quantity or row.quantity <= 0:
				frappe.throw(_("Количество в упаковке должно быть больше нуля."))

