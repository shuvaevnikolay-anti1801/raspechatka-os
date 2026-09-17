import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class FinancePlanItem(Document):
	def validate(self):
		if flt(self.amount) <= 0:
			frappe.throw(_("Плановая сумма должна быть больше нуля"))
		if self.business_point and frappe.db.get_value("Business Point", self.business_point, "business_entity") != self.business_entity:
			frappe.throw(_("Точка продаж должна относиться к выбранному ИП"))
