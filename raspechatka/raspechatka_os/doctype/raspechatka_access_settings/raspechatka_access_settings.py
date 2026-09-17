import frappe
from frappe import _
from frappe.model.document import Document


class RaspechatkaAccessSettings(Document):
	def validate(self):
		pairs = [(row.role, row.access_area) for row in self.rules]
		if len(pairs) != len(set(pairs)):
			frappe.throw(_("Для роли и раздела можно создать только одно правило"))
