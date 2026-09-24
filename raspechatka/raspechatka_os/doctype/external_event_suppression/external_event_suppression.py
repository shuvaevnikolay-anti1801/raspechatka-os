import frappe
from frappe.model.document import Document


class ExternalEventSuppression(Document):
	def validate(self):
		if not self.is_new():
			frappe.throw("Immutable record", frappe.PermissionError)

	def on_trash(self):
		frappe.throw("Immutable record", frappe.PermissionError)
