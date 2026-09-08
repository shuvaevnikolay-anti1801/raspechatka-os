import frappe
from frappe.model.document import Document

class EmployeeLeave(Document):
	def validate(self):
		if self.date_to < self.date_from:
			frappe.throw("Дата окончания не может быть раньше даты начала")
