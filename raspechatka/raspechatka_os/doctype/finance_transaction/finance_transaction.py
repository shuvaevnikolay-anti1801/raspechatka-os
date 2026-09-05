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
			article_type = frappe.db.get_value("Financial Article", self.financial_article, "article_type")
			if self.direction == "Income" and article_type != "Income":
				frappe.throw(_("Для прихода выберите статью доходов"))
			if self.direction == "Expense" and article_type != "Expense":
				frappe.throw(_("Для расхода выберите статью расходов"))

	def before_submit(self):
		self.status = "Posted"

	def on_cancel(self):
		self.db_set("status", "Cancelled")
