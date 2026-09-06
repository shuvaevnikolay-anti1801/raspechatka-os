import frappe
from frappe import _
from frappe.model.document import Document


class EmployeeMotivationResult(Document):
	def validate(self):
		self.business_point = frappe.db.get_value("Motivation Period", self.motivation_period, "business_point")
		duplicate = frappe.db.exists(
			"Employee Motivation Result",
			{
				"motivation_period": self.motivation_period,
				"employee": self.employee,
				"name": ["!=", self.name],
			},
		)
		if duplicate:
			frappe.throw(_("Для сотрудника уже есть результат за этот период"))

