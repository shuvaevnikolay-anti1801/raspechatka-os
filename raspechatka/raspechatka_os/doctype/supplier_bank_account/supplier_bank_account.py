import re

import frappe
from frappe import _
from frappe.model.document import Document


class SupplierBankAccount(Document):
	def validate(self):
		for fieldname in ("settlement_account", "bic", "correspondent_account"):
			self.set(fieldname, re.sub(r"\D", "", self.get(fieldname) or ""))
		if len(self.settlement_account) != 20 or len(self.bic) != 9:
			frappe.throw(_("Расчётный счёт должен содержать 20 цифр, БИК — 9 цифр"))
