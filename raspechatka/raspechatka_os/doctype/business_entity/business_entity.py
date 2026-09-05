import re

import frappe
from frappe import _
from frappe.model.document import Document


class BusinessEntity(Document):
	def validate(self):
		self.inn = _digits(self.inn)
		self.ogrnip = _digits(self.ogrnip)
		self.okpo = _digits(self.okpo)

		if self.inn and len(self.inn) != 12:
			frappe.throw(_("ИНН индивидуального предпринимателя должен содержать 12 цифр"))
		if self.ogrnip and len(self.ogrnip) != 15:
			frappe.throw(_("ОГРНИП должен содержать 15 цифр"))


def _digits(value):
	return re.sub(r"\D", "", value or "")
