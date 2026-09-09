# ruff: noqa: RUF001
from __future__ import annotations

import hashlib

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class SupplierPaymentAllocation(Document):
	def before_insert(self):
		self.allocation_key = hashlib.sha256(
			f"{self.purchase_order}|{self.finance_transaction}".encode()
		).hexdigest()

	def validate(self):
		order = frappe.db.get_value(
			"Purchase Order",
			self.purchase_order,
			["docstatus", "supplier", "business_entity", "total_amount"],
			as_dict=True,
		)
		if not order or order.docstatus != 1:
			frappe.throw(_("Оплату можно связать только с проведённым заказом поставщику."))

		payment = frappe.db.get_value(
			"Finance Transaction",
			self.finance_transaction,
			["docstatus", "status", "direction", "amount", "supplier", "business_entity", "posting_date"],
			as_dict=True,
		)
		if not payment or payment.docstatus != 1 or payment.status != "Posted":
			frappe.throw(_("Выберите проведённый платёж."))
		if payment.direction != "Expense":
			frappe.throw(_("С заказом поставщику можно связать только расход."))
		if payment.business_entity != order.business_entity:
			frappe.throw(_("Платёж и заказ должны относиться к одному юридическому лицу."))
		if payment.supplier != order.supplier:
			frappe.throw(_("Поставщик платежа не совпадает с поставщиком заказа."))
		if flt(self.allocated_amount) <= 0:
			frappe.throw(_("Зачтённая сумма должна быть больше нуля."))

		payment_allocated = _allocated_total(
			"finance_transaction",
			self.finance_transaction,
			exclude=self.name,
		)
		if payment_allocated + flt(self.allocated_amount) > flt(payment.amount):
			frappe.throw(_("Распределение превышает свободный остаток платежа."))

		order_allocated = _allocated_total(
			"purchase_order",
			self.purchase_order,
			exclude=self.name,
		)
		if order_allocated + flt(self.allocated_amount) > flt(order.total_amount):
			frappe.throw(_("Распределение превышает задолженность по заказу."))

		self.supplier = order.supplier
		self.business_entity = order.business_entity
		self.posting_date = payment.posting_date

	def after_insert(self):
		update_purchase_order_payment_totals(self.purchase_order)

	def after_delete(self):
		update_purchase_order_payment_totals(self.purchase_order)


def _allocated_total(fieldname, value, exclude=None):
	filters = {fieldname: value}
	if exclude:
		filters["name"] = ["!=", exclude]
	amounts = frappe.get_all(
		"Supplier Payment Allocation",
		filters=filters,
		pluck="allocated_amount",
		limit_page_length=0,
	)
	return sum(flt(amount) for amount in amounts)


def update_purchase_order_payment_totals(order_name):
	if not order_name or not frappe.db.exists("Purchase Order", order_name):
		return
	order = frappe.db.get_value(
		"Purchase Order",
		order_name,
		["total_amount", "docstatus"],
		as_dict=True,
	)
	paid_amount = 0
	if order.docstatus == 1:
		paid_amount = flt(
			frappe.db.sql(
				"""
				select coalesce(sum(allocation.allocated_amount), 0)
				from `tabSupplier Payment Allocation` allocation
				join `tabFinance Transaction` payment
					on payment.name = allocation.finance_transaction
				where allocation.purchase_order = %s
					and payment.docstatus = 1
					and payment.status = 'Posted'
				""",
				(order_name,),
			)[0][0]
		)
	outstanding_amount = max(flt(order.total_amount) - paid_amount, 0)
	payment_status = (
		"Оплачено"
		if flt(order.total_amount) and not outstanding_amount
		else "Частично оплачено"
		if paid_amount
		else "Не оплачено"
	)
	frappe.db.set_value(
		"Purchase Order",
		order_name,
		{
			"paid_amount": paid_amount,
			"outstanding_amount": outstanding_amount,
			"payment_status": payment_status,
		},
		update_modified=False,
	)


def update_orders_for_payment(payment_name):
	orders = frappe.get_all(
		"Supplier Payment Allocation",
		filters={"finance_transaction": payment_name},
		pluck="purchase_order",
		distinct=True,
		limit_page_length=0,
	)
	for order_name in orders:
		update_purchase_order_payment_totals(order_name)
