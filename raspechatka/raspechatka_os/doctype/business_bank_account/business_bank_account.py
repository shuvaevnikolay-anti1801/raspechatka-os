import re

import frappe
from frappe import _
from frappe.model.document import Document


class BusinessBankAccount(Document):
	def validate(self):
		for fieldname in ("settlement_account", "bic", "correspondent_account"):
			self.set(fieldname, re.sub(r"\D", "", self.get(fieldname) or ""))

		if len(self.settlement_account or "") != 20:
			frappe.throw(_("Расчётный счёт должен содержать 20 цифр"))
		if len(self.bic or "") != 9:
			frappe.throw(_("БИК должен содержать 9 цифр"))
