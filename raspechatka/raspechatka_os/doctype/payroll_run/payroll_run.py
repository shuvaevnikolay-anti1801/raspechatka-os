import frappe
from frappe.model.document import Document

class PayrollRun(Document):
	def validate(self):
		if self.period_end < self.period_start:
			frappe.throw("Дата окончания периода не может быть раньше даты начала")
