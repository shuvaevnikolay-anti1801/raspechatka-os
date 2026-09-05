import frappe
from frappe import _
from frappe.model.document import Document


class AccessArea(Document):
	def on_trash(self):
		if self.system_area:
			frappe.throw(_("Системный раздел нельзя удалить"))
