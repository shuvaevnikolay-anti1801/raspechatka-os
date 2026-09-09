import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class FinanceTransaction(Document):
	def validate(self):
		if flt(self.amount) <= 0:
			frappe.throw(_("Сумма платежа должна быть больше нуля"))
		if self.business_point and frappe.db.get_value("Business Point", self.business_point, "business_entity") != self.business_entity:
			frappe.throw(_("Точка продаж должна относиться к выбранному ИП"))
		if self.financial_article:
			article = frappe.db.get_value(
				"Financial Article",
				self.financial_article,
				["article_type", "active", "is_group", "cash_flow_type"],
				as_dict=True,
			)
			if not article or not article.active or article.is_group:
				frappe.throw(_("Выберите активную финансовую статью, которая не является группой"))
			article_type = article.article_type
			if self.direction == "Income" and article_type != "Income":
				frappe.throw(_("Для прихода выберите статью доходов"))
			if self.direction == "Expense" and article_type != "Expense":
				frappe.throw(_("Для расхода выберите статью расходов"))
			if not self.cash_flow_type:
				self.cash_flow_type = article.cash_flow_type or "Operating"
		if self.source == "Tochka Bank" and not self.bank_operation:
			frappe.throw(_("Банковский платёж должен быть связан с исходной операцией банка"))
		if self.source == "Cash":
			if not self.cash_movement:
				frappe.throw(_("Кассовый платёж должен быть связан с кассовой операцией"))
			movement = frappe.db.get_value(
				"Cash Movement",
				self.cash_movement,
				["movement_type", "withdrawal_purpose"],
				as_dict=True,
			)
			valid_cash_flow = movement and movement.movement_type == "Withdrawal" and (
				(self.direction == "Expense" and movement.withdrawal_purpose == "Expense")
				or (self.direction == "Income" and movement.withdrawal_purpose == "Collection")
			)
			if not valid_cash_flow:
				frappe.throw(_("Кассовый платёж не соответствует связанной кассовой операции"))
		if self.source == "Manual" and self.is_new():
			frappe.throw(_("Ручное создание произвольных платежей отключено"))

	def before_submit(self):
		self.status = "Posted"
		if not self.processing_status:
			self.processing_status = "Auto Posted" if self.source == "Tochka Bank" else "Manual Posted"

	def before_cancel(self):
		if self.source == "Tochka Bank":
			frappe.throw(_("Банковский платёж нельзя отменить вручную: исправьте правило обработки исходной операции"))

	def on_cancel(self):
		self.db_set("status", "Cancelled")
		from raspechatka.raspechatka_os.doctype.supplier_payment_allocation.supplier_payment_allocation import (
			update_orders_for_payment,
		)

		update_orders_for_payment(self.name)

	def on_trash(self):
		if self.source in ("Tochka Bank", "Cash"):
			frappe.throw(_("Платежи из банка и кассы нельзя удалять"))
		if frappe.db.exists(
			"Supplier Payment Allocation",
			{"finance_transaction": self.name},
		):
			frappe.throw(_("Перед удалением платежа удалите его связи с заказами."))  # noqa: RUF001
