import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate


class FinanceBudget(Document):
	def validate(self):
		self.month = getdate(self.month).replace(day=1)
		filters = {"business_entity": self.business_entity, "month": self.month, "business_point": self.business_point or ["is", "not set"]}
		existing = frappe.db.get_value("Finance Budget", filters, "name")
		if existing and existing != self.name:
			frappe.throw(_("План для этого ИП, точки и месяца уже существует"))
		seen = set()
		for row in self.lines:
			if row.financial_article in seen:
				frappe.throw(_("Финансовую статью можно указать в плане только один раз"))
			seen.add(row.financial_article)
