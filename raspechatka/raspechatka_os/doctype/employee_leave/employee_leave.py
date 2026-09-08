import frappe
from frappe.model.document import Document
from frappe.utils import date_diff, getdate

class EmployeeLeave(Document):
	def validate(self):
		if getdate(self.date_to) < getdate(self.date_from):
			frappe.throw("Дата окончания не может быть раньше даты начала")
		self.days = date_diff(self.date_to, self.date_from) + 1
