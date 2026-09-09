# ruff: noqa: RUF001

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, get_datetime, now_datetime
from raspechatka.stock import (
	get_average_rate,
	make_ledger_entry,
	validate_chronology,
	validate_location,
	validate_warehouse_header,
)


class SalesReceipt(Document):
	def before_insert(self):
		self.posting_datetime = self.posting_datetime or now_datetime()

	def validate(self):
		mirror_only = bool(self.mirror_only)
		validate_warehouse_header(self.business_entity, self.business_point, self.warehouse)
		shift = frappe.db.get_value(
			"Sales Shift",
			self.shift,
			[
				"business_entity",
				"business_point",
				"warehouse",
				"cashier",
				"opened_at",
				"closed_at",
				"status",
			],
			as_dict=True,
		)
		if not shift or (
			shift.business_entity,
			shift.business_point,
			shift.warehouse,
		) != (self.business_entity, self.business_point, self.warehouse):
			frappe.throw(_("Чек должен относиться к ИП, точке и складу выбранной смены"))
		if shift.cashier and self.cashier != shift.cashier:
			frappe.throw(_("Кассир чека должен совпадать с кассиром смены"))
		posting = get_datetime(self.posting_datetime)
		if posting < get_datetime(shift.opened_at) or (
			shift.closed_at and posting > get_datetime(shift.closed_at)
		):
			frappe.throw(_("Время чека должно находиться внутри смены"))
		if self.receipt_type == "Return" and not self.original_receipt and not mirror_only:
			frappe.throw(_("Для возврата укажите исходную продажу"))
		if (
			self.original_receipt
			and frappe.db.get_value("Sales Receipt", self.original_receipt, "receipt_type") != "Sale"
		):
			frappe.throw(_("Исходным документом возврата может быть только продажа"))
		if (
			self.original_receipt
			and frappe.db.get_value("Sales Receipt", self.original_receipt, "business_point")
			!= self.business_point
		):
			frappe.throw(_("Продажа и возврат должны относиться к одной точке"))
		if not self.items or not self.payments:
			frappe.throw(_("Добавьте позиции и оплаты"))
		point_rules = frappe.db.get_value(
			"Business Point",
			self.business_point,
			["allow_discounts", "max_discount_percent"],
			as_dict=True,
		)
		gross = discount = cost = 0
		for row in self.items:
			item = frappe.db.get_value(
				"Catalog Item",
				row.item,
				[
					"item_code",
					"item_name",
					"item_type",
					"stock_uom",
					"track_inventory",
					"active",
				],
				as_dict=True,
			)
			if not item or (not item.active and not mirror_only):
				frappe.throw(_("В чеке есть неактивная или неизвестная позиция"))
			if flt(row.quantity) <= 0 or flt(row.unit_price) < 0:
				frappe.throw(_("Количество должно быть больше нуля, цена не может быть отрицательной"))
			row.item_code, row.item_name, row.uom = (
				item.item_code,
				item.item_name,
				row.uom or item.stock_uom,
			)
			row.gross_amount = flt(row.quantity) * flt(row.unit_price)
			if not flt(row.discount_amount) and flt(row.discount_percent):
				row.discount_amount = row.gross_amount * flt(row.discount_percent) / 100
			if flt(row.discount_amount) < 0 or flt(row.discount_amount) > flt(row.gross_amount):
				frappe.throw(_("Некорректная скидка в строке {0}").format(row.idx))
			actual_discount_percent = (
				flt(row.discount_amount) / flt(row.gross_amount) * 100 if flt(row.gross_amount) else 0
			)
			if (
				not mirror_only
				and actual_discount_percent
				and (
					not point_rules.allow_discounts
					or actual_discount_percent > flt(point_rules.max_discount_percent) + 0.001
				)
			):
				frappe.throw(_("Скидка в строке {0} превышает разрешённую для точки").format(row.idx))
			row.line_total = flt(row.gross_amount) - flt(row.discount_amount)
			if item.item_type in {"Product", "Variant"} and item.track_inventory:
				row.valuation_rate = (
					self._get_original_rate(row.item)
					if self.receipt_type == "Return" and self.original_receipt
					else get_average_rate(row.item, self.warehouse, self.posting_datetime)
				)
			else:
				row.valuation_rate = 0
			row.cost_amount = flt(row.quantity) * flt(row.valuation_rate)
			validate_location(row.storage_location, self.warehouse)
			gross += flt(row.gross_amount)
			discount += flt(row.discount_amount)
			cost += flt(row.cost_amount)
		if not mirror_only:
			self._prepare_consumed_materials()
			cost = sum(flt(row.cost_amount) for row in self.items)
		self.gross_amount, self.discount_amount, self.total_amount, self.cost_amount = (
			gross,
			discount,
			gross - discount,
			cost,
		)
		self.profit_amount = (-1 if self.receipt_type == "Return" else 1) * (flt(self.total_amount) - cost)
		paid = sum(flt(row.amount) for row in self.payments)
		if abs(paid - flt(self.total_amount)) > 0.01:
			frappe.throw(_("Сумма оплат должна совпадать с итогом чека"))
		if (
			flt(self.review_discount_amount) + flt(self.other_discount_amount)
			> flt(self.discount_amount) + 0.01
		):
			frappe.throw(_("Разбивка скидки превышает общую скидку"))
		if self.receipt_type == "Return" and not mirror_only:
			self._validate_return_quantities()

	def _validate_return_quantities(self):
		original = frappe.get_all(
			"Sales Receipt Item",
			filters={"parent": self.original_receipt},
			fields=["item", "quantity"],
		)
		available = {}
		for row in original:
			available[row.item] = available.get(row.item, 0) + flt(row.quantity)
		other_returns = frappe.get_all(
			"Sales Receipt",
			filters={
				"original_receipt": self.original_receipt,
				"receipt_type": "Return",
				"docstatus": 1,
				"name": ["!=", self.name or ""],
			},
			pluck="name",
		)
		for row in frappe.get_all(
			"Sales Receipt Item",
			filters={"parent": ["in", other_returns or ["__none__"]]},
			fields=["item", "quantity"],
		):
			available[row.item] = available.get(row.item, 0) - flt(row.quantity)
		requested = {}
		for row in self.items:
			requested[row.item] = requested.get(row.item, 0) + flt(row.quantity)
			if requested[row.item] > available.get(row.item, 0) + 0.000001:
				frappe.throw(
					_("Возвращаемое количество товара {0} превышает остаток исходной продажи").format(
						row.item_name
					)
				)

	def before_submit(self):
		if not self.mirror_only:
			validate_chronology(self.warehouse, self.posting_datetime)
		self.status = "Posted"

	def on_submit(self):
		if not self.mirror_only:
			self._create_stock_entries(False)
			self._create_profitability(False)
			self._create_client_purchase()
		from raspechatka.sales import log_cashier_action, update_shift_totals

		log_cashier_action(self, "SALE" if self.receipt_type == "Sale" else "RETURN")
		update_shift_totals(self.shift)

	def before_cancel(self):
		self.status = "Cancelled"

	def on_cancel(self):
		if not self.mirror_only:
			self._create_stock_entries(True)
			self._create_profitability(True)
		if self.receipt_type == "Sale":
			frappe.db.set_value(
				"Client Purchase",
				{"source_document": self.name},
				"cancelled",
				1,
				update_modified=False,
			)
		from raspechatka.sales import log_cashier_action, update_shift_totals

		log_cashier_action(self, "CANCEL_RECEIPT")
		update_shift_totals(self.shift)

	def _prepare_consumed_materials(self):
		self.set("consumed_materials", [])
		for row in self.items:
			item_type = frappe.db.get_value("Catalog Item", row.item, "item_type")
			if item_type == "Bundle":
				materials = self._bundle_materials(row.item, flt(row.quantity))
			elif item_type == "Service":
				materials = self._service_materials(row.item, flt(row.quantity))
			else:
				continue
			row_cost = 0
			for material in materials:
				rate = get_average_rate(
					material["material"], self.warehouse, self.posting_datetime
				)
				amount = flt(material["quantity"]) * rate
				self.append(
					"consumed_materials",
					{
						"sales_item_idx": row.idx,
						"sold_item": row.item,
						"material": material["material"],
						"quantity": material["quantity"],
						"uom": material["uom"],
						"storage_location": row.storage_location,
						"valuation_rate": rate,
						"cost_amount": amount,
						"source_type": material["source_type"],
						"effective_from": material.get("effective_from"),
					},
				)
				row_cost += amount
			row.cost_amount = row_cost
			row.valuation_rate = row_cost / flt(row.quantity) if flt(row.quantity) else 0

	def _bundle_materials(self, bundle, sale_quantity):
		result = []
		for component in frappe.get_all(
			"Catalog Bundle Component",
			filters={"parent": bundle, "parenttype": "Catalog Item"},
			fields=["item", "quantity", "uom"],
			order_by="idx asc",
		):
			component_type = frappe.db.get_value("Catalog Item", component.item, "item_type")
			quantity = sale_quantity * flt(component.quantity)
			if component_type == "Service":
				result.extend(self._service_materials(component.item, quantity))
			else:
				result.append(
					{
						"material": component.item,
						"quantity": quantity,
						"uom": component.uom
						or frappe.db.get_value("Catalog Item", component.item, "stock_uom"),
						"source_type": "Bundle",
					}
				)
		return self._merge_materials(result)

	def _service_materials(self, service, sale_quantity):
		posting_date = get_datetime(self.posting_datetime).date()
		rows = frappe.get_all(
			"Catalog Recipe Component",
			filters={
				"parent": service,
				"parenttype": "Catalog Item",
				"effective_from": ["<=", posting_date],
			},
			fields=[
				"material",
				"quantity",
				"uom",
				"loss_percent",
				"effective_from",
				"business_point",
			],
			order_by="effective_from desc, idx desc",
		)
		selected = {}
		for recipe in rows:
			if recipe.business_point not in (None, "", self.business_point):
				continue
			current = selected.get(recipe.material)
			if current and (current.business_point == self.business_point or not recipe.business_point):
				continue
			selected[recipe.material] = recipe
		result = []
		for recipe in selected.values():
			result.append(
				{
					"material": recipe.material,
					"quantity": sale_quantity
					* flt(recipe.quantity)
					* (1 + flt(recipe.loss_percent) / 100),
					"uom": recipe.uom,
					"source_type": "Recipe",
					"effective_from": recipe.effective_from,
				}
			)
		return result

	def _merge_materials(self, rows):
		merged = {}
		for row in rows:
			key = (row["material"], row["uom"], row["source_type"], row.get("effective_from"))
			if key not in merged:
				merged[key] = dict(row)
			else:
				merged[key]["quantity"] += flt(row["quantity"])
		return list(merged.values())

	def _create_stock_entries(self, reversal):
		for row in self.items:
			item = frappe.db.get_value(
				"Catalog Item", row.item, ["item_type", "track_inventory"], as_dict=True
			)
			if not item or item.item_type not in {"Product", "Variant"} or not item.track_inventory:
				continue
			sign = -1 if self.receipt_type == "Sale" else 1
			make_ledger_entry(
				self,
				row,
				sign * flt(row.quantity),
				flt(row.valuation_rate),
				sign * flt(row.cost_amount),
				reversal=reversal,
				valuation_source=(
					"Original sale cost" if self.receipt_type == "Return"
					else "Warehouse weighted average"
				),
			)
		for row in self.consumed_materials:
			proxy = frappe._dict(
				name=row.name,
				item=row.material,
				storage_location=row.storage_location,
			)
			sign = -1 if self.receipt_type == "Sale" else 1
			make_ledger_entry(
				self,
				proxy,
				sign * flt(row.quantity),
				flt(row.valuation_rate),
				sign * flt(row.cost_amount),
				reversal=reversal,
				valuation_source="Frozen receipt composition",
			)

	def _get_original_rate(self, item):
		rows = frappe.get_all(
			"Sales Receipt Item",
			filters={"parent": self.original_receipt, "item": item},
			fields=["quantity", "cost_amount"],
		)
		quantity = sum(flt(row.quantity) for row in rows)
		return sum(flt(row.cost_amount) for row in rows) / quantity if quantity else 0

	def _create_profitability(self, reversal):
		factor = -1 if reversal else 1
		for row in self.items:
			entry = frappe.new_doc("Profitability Entry")
			entry.posting_date = self.posting_datetime.date()
			entry.business_entity, entry.business_point, entry.item = (
				self.business_entity,
				self.business_point,
				row.item,
			)
			entry.quantity = factor * flt(row.quantity) * (-1 if self.receipt_type == "Return" else 1)
			if self.receipt_type == "Sale":
				entry.revenue, entry.cost_amount, entry.discount_amount = (
					factor * flt(row.gross_amount),
					factor * flt(row.cost_amount),
					factor * flt(row.discount_amount),
				)
			else:
				entry.return_amount, entry.cost_amount = (
					factor * flt(row.line_total),
					-factor * flt(row.cost_amount),
				)
			entry.source_doctype, entry.source_document = self.doctype, self.name
			entry.insert(ignore_permissions=True)

	def _create_client_purchase(self):
		if self.receipt_type != "Sale" or not self.client:
			return
		purchase = frappe.new_doc("Client Purchase")
		purchase.purchase_datetime, purchase.client, purchase.business_point = (
			self.posting_datetime,
			self.client,
			self.business_point,
		)
		purchase.source_doctype, purchase.source_document = self.doctype, self.name
		purchase.gross_amount, purchase.discount_amount, purchase.net_amount = (
			self.gross_amount,
			self.discount_amount,
			self.total_amount,
		)
		purchase.promo_code, purchase.campaign = self.promo_code, self.campaign
		purchase.insert(ignore_permissions=True)
