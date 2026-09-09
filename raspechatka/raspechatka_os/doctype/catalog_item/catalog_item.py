# Copyright (c) 2026, Raspechatka and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.model.naming import make_autoname
from frappe.utils import flt


class CatalogItem(Document):
	def before_insert(self):
		if not self.item_code:
			self.item_code = make_autoname("CAT-.#####")

	def validate(self):
		self._clean_identifiers()
		self._apply_type_rules()
		self._validate_group_and_unit()
		self._validate_supplier()
		self._validate_variant()
		self._validate_rows()

	def on_update(self):
		self._refresh_variant_parent()

	def _clean_identifiers(self):
		self.item_code = (self.item_code or "").strip()
		self.item_name = (self.item_name or "").strip()
		self.article = (self.article or "").strip() or None
		self.external_code = (self.external_code or "").strip() or None

	def _apply_type_rules(self):
		if self.item_type in {"Service", "Bundle"}:
			self.track_inventory = 0
		else:
			self.track_inventory = 1
		self.allow_negative_stock = 0
		self.valuation_method = "Moving Average"
		self.tracking_method = "None"
		self.vat_rate = "Без НДС"
		self.tax_system = "По настройке точки"
		self.receipt_subject = "Услуга" if self.item_type == "Service" else "Товар"

		if self.item_type == "Service":
			self.set("bundle_components", [])
			self.set("reorder_rules", [])

		if self.item_type in {"Product", "Variant"}:
			self.set("bundle_components", [])

		if self.item_type != "Service":
			self.set("recipe_components", [])

		if self.item_type == "Bundle" and not self.bundle_components:
			frappe.throw(_("Добавьте хотя бы один товар в состав комплекта."))

	def _validate_group_and_unit(self):
		if self.catalog_group and not frappe.db.get_value("Catalog Group", self.catalog_group, "active"):
			frappe.throw(_("Нельзя поместить позицию в архивную группу."))
		if self.stock_uom and not frappe.db.get_value("Catalog Unit", self.stock_uom, "active"):
			frappe.throw(_("Нельзя использовать архивную единицу измерения."))
		if self.stock_uom not in {"шт", "мес"}:
			frappe.throw(_("Допустимые единицы измерения: шт или мес."))

	def _validate_supplier(self):
		if self.default_supplier and not frappe.db.exists(
			"Catalog Supplier", {"name": self.default_supplier, "active": 1}
		):
			frappe.throw(_("Основной поставщик должен быть выбран из активного справочника поставщиков."))

	def _validate_variant(self):
		if self.item_type != "Variant":
			self.variant_of = None
			self.set("variant_values", [])
			return
		if not self.variant_of:
			frappe.throw(_("Для модификации выберите основной товар."))
		parent = frappe.db.get_value(
			"Catalog Item",
			self.variant_of,
			["active", "item_type", "catalog_group", "stock_uom", "default_supplier"],
			as_dict=True,
		)
		if not parent or not parent.active or parent.item_type != "Product":
			frappe.throw(_("Основой модификации может быть только активный товар."))
		if self.name and self.variant_of == self.name:
			frappe.throw(_("Модификация не может ссылаться сама на себя."))
		if not self.variant_values:
			frappe.throw(_("Добавьте хотя бы один параметр модификации."))
		self.catalog_group = parent.catalog_group
		self.stock_uom = parent.stock_uom
		self.default_supplier = self.default_supplier or parent.default_supplier

		values = []
		for row in self.variant_values:
			row.attribute_name = (row.attribute_name or "").strip()
			row.attribute_value = (row.attribute_value or "").strip()
			if not row.attribute_name or not row.attribute_value:
				frappe.throw(_("У каждого параметра модификации должны быть название и значение."))
			values.append((row.attribute_name.casefold(), row.attribute_value.casefold()))
		if len(values) != len({name for name, _value in values}):
			frappe.throw(_("Название параметра модификации нельзя повторять."))
		signature = sorted(values)
		for variant in frappe.get_all(
			"Catalog Item",
			filters={"variant_of": self.variant_of, "name": ["!=", self.name or ""]},
			pluck="name",
		):
			other = frappe.get_doc("Catalog Item", variant)
			other_signature = sorted(
				((row.attribute_name or "").strip().casefold(), (row.attribute_value or "").strip().casefold())
				for row in other.variant_values
			)
			if signature == other_signature:
				frappe.throw(_("Модификация с такими параметрами уже существует."))

	def _refresh_variant_parent(self):
		parents = {self.variant_of} if self.variant_of else set()
		before = self.get_doc_before_save()
		if before and self.has_value_changed("variant_of"):
			parents.add(before.variant_of)
		for parent in filter(None, parents):
			has_variants = bool(
				frappe.db.exists("Catalog Item", {"variant_of": parent, "active": 1})
			)
			frappe.db.set_value("Catalog Item", parent, "has_variants", has_variants, update_modified=False)

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

			scope = (
				row.price_type,
				row.business_point or "",
				row.uom or self.stock_uom,
				row.currency or "RUB",
				row.minimum_quantity,
			)
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
			component = frappe.db.get_value(
				"Catalog Item", row.item, ["active", "item_type"], as_dict=True
			)
			if not component:
				frappe.throw(_("Не найдена позиция состава комплекта."))
			if self.active and not component.active:
				frappe.throw(_("В активный комплект нельзя добавить архивную позицию."))
			if component.item_type not in {"Product", "Service", "Variant"}:
				frappe.throw(_("Комплект может состоять только из товаров, услуг и модификаций."))
			if self.name and self._bundle_reaches(row.item, self.name):
				frappe.throw(_("Обнаружена циклическая связь комплектов."))
			if row.item == self.name:
				frappe.throw(_("Комплект не может включать сам себя."))
			if not row.quantity or row.quantity <= 0:
				frappe.throw(_("Количество компонента комплекта должно быть больше нуля."))


		recipe_keys = set()
		for row in self.recipe_components:
			material = frappe.db.get_value(
				"Catalog Item",
				row.material,
				["active", "item_type", "track_inventory", "stock_uom"],
				as_dict=True,
			)
			if not material or not material.active:
				frappe.throw(_("В технологической карте есть неизвестный или архивный материал."))
			if material.item_type not in {"Product", "Variant"} or not material.track_inventory:
				frappe.throw(_("Технологическая карта может расходовать только складские товары."))
			if row.uom != material.stock_uom:
				frappe.throw(_("Единица материала должна совпадать с его складской единицей."))
			if flt(row.quantity) <= 0:
				frappe.throw(_("Количество материала должно быть больше нуля."))
			if flt(row.loss_percent) < 0 or flt(row.loss_percent) > 100:
				frappe.throw(_("Допустимые потери должны быть от 0 до 100%."))
			if row.business_point and not frappe.db.exists(
				"Business Point", {"name": row.business_point, "active": 1}
			):
				frappe.throw(_("В технологической карте выбрана неактивная точка."))
			key = (row.material, row.business_point or "", row.effective_from)
			if key in recipe_keys:
				frappe.throw(_("Одинаковую норму материала нельзя указывать дважды."))
			recipe_keys.add(key)


		recipe_keys = set()
		for row in self.recipe_components:
			material = frappe.db.get_value(
				"Catalog Item",
				row.material,
				["active", "item_type", "stock_uom", "track_inventory"],
				as_dict=True,
			)
			if (
				not material
				or not material.active
				or material.item_type not in {"Product", "Variant"}
				or not material.track_inventory
			):
				frappe.throw(_("В технологической карте можно использовать только активный складской материал."))
			if row.uom != material.stock_uom:
				frappe.throw(_("Единица материала в технологической карте должна совпадать с его складской единицей."))
			if not row.quantity or row.quantity <= 0:
				frappe.throw(_("Норма расхода материала должна быть больше нуля."))
			if row.loss_percent < 0 or row.loss_percent > 100:
				frappe.throw(_("Допустимые потери должны быть от 0 до 100%."))
			if row.business_point and not frappe.db.exists(
				"Business Point", {"name": row.business_point, "active": 1}
			):
				frappe.throw(_("В технологической карте указана неактивная точка продаж."))
			key = (row.material, row.business_point or "", row.effective_from)
			if key in recipe_keys:
				frappe.throw(_("Одинаковую норму материала, точки и даты нельзя указывать дважды."))
			recipe_keys.add(key)
