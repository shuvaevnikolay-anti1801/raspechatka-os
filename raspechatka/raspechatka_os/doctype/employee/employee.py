import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate


class Employee(Document):
	def validate(self):
		self.employee_name = " ".join(
			filter(None, (self.last_name, self.first_name, self.middle_name))
		).strip()
		if (
			self.hire_date
			and self.dismissal_date
			and getdate(self.dismissal_date) < getdate(self.hire_date)
		):
			frappe.throw(_("Дата увольнения не может быть раньше даты приёма"))
		if self.system_user_profile:
			linked_employee = frappe.db.get_value(
				"Raspechatka User Profile",
				self.system_user_profile,
				"linked_employee",
			)
			if linked_employee and linked_employee != self.name:
				frappe.throw(_("Пользователь уже связан с другим сотрудником"))  # noqa: RUF001
