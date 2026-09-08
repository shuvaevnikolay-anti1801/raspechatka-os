import frappe
from frappe import _
from frappe.model.document import Document

class PayrollPolicy(Document):
	def validate(self):
		entity = frappe.db.get_value("Business Point", self.business_point, "business_entity")
		if entity != self.business_entity:
			frappe.throw(_("Точка должна относиться к выбранному юридическому лицу"))
