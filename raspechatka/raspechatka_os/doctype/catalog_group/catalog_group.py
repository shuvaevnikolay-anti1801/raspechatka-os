import frappe
from frappe import _
from frappe.model.document import Document


class CatalogGroup(Document):
	def validate(self):
		if self.parent_catalog_group == self.name:
			frappe.throw(_("Группа не может быть родителем самой себя."))

