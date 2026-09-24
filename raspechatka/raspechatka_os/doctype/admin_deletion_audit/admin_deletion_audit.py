import frappe
from frappe import _
from frappe.model.document import Document


class AdminDeletionAudit(Document):
	def validate(self):
		if not self.is_new():
			frappe.throw(_("Журнал удаления нельзя изменять"), frappe.PermissionError)

	def on_trash(self):
		frappe.throw(_("Журнал удаления нельзя удалять"), frappe.PermissionError)
