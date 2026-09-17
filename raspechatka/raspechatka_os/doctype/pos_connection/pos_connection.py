import frappe
from frappe import _
from frappe.model.document import Document


class POSConnection(Document):
	def validate(self):
		entity = frappe.db.get_value("Business Point", self.business_point, "business_entity")
		if not entity:
			frappe.throw(_("Выберите существующую точку продаж"))
		self.business_entity = entity
