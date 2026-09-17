import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate

from raspechatka.requisites import digits, is_valid_bank_account, is_valid_bic, is_valid_inn, is_valid_snils


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
		if self.inn and not is_valid_inn(self.inn):
			frappe.throw(_("Некорректный ИНН сотрудника"))
		if self.snils and not is_valid_snils(self.snils):
			frappe.throw(_("Некорректный СНИЛС сотрудника"))
		if self.salary_bic and not is_valid_bic(self.salary_bic):
			frappe.throw(_("БИК должен содержать 9 цифр"))
		if self.salary_account and not is_valid_bank_account(self.salary_account, self.salary_bic):
			frappe.throw(_("Некорректный банковский счёт сотрудника"))
		if self.salary_correspondent_account and not is_valid_bank_account(
			self.salary_correspondent_account, self.salary_bic, correspondent=True
		):
			frappe.throw(_("Некорректный корреспондентский счёт"))
		if self.passport_series and len(digits(self.get_password("passport_series", raise_exception=False))) != 4:
			frappe.throw(_("Серия паспорта должна содержать 4 цифры"))
		if self.passport_number and len(digits(self.get_password("passport_number", raise_exception=False))) != 6:
			frappe.throw(_("Номер паспорта должен содержать 6 цифр"))
		if self.system_user_profile:
			linked_employee = frappe.db.get_value(
				"Raspechatka User Profile",
				self.system_user_profile,
				"linked_employee",
			)
			if linked_employee and linked_employee != self.name:
				frappe.throw(_("Пользователь уже связан с другим сотрудником"))  # noqa: RUF001
