import re

import frappe
from frappe import _
from frappe.model.document import Document


class FinanceClassificationRule(Document):
	def validate(self):
		if self.purpose_regex:
			try:
				re.compile(self.purpose_regex)
			except re.error as error:
				frappe.throw(_("Некорректное регулярное выражение: {0}").format(error))
