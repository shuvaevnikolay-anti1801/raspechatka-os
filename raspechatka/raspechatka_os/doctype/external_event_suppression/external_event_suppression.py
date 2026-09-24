import frappe
from frappe import _
from frappe.model.document import Document


class ExternalEventSuppression(Document):
	def validate(self):
		if not self.is_new():
			frappe.throw(_("Запись подавления события нельзя изменять"), frappe.PermissionError)

	def on_trash(self):
		frappe.throw(_("Запись подавления события нельзя удалять"), frappe.PermissionError)
