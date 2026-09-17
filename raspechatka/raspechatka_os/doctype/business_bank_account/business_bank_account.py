import frappe
from frappe import _
from frappe.model.document import Document

from raspechatka.requisites import digits, is_valid_bank_account, is_valid_bic


class BusinessBankAccount(Document):
	def validate(self):
		for fieldname in ("settlement_account", "bic", "correspondent_account"):
			self.set(fieldname, digits(self.get(fieldname)))

		if not is_valid_bic(self.bic):
			frappe.throw(_("БИК должен содержать 9 цифр"))
		if not is_valid_bank_account(self.settlement_account, self.bic):
			frappe.throw(_("Расчётный счёт не прошёл проверку по БИК"))
		if self.correspondent_account and not is_valid_bank_account(self.correspondent_account, self.bic, correspondent=True):
			frappe.throw(_("Корреспондентский счёт не прошёл проверку по БИК"))
