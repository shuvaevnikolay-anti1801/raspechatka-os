import frappe
from frappe import _
from frappe.model.document import Document


class PaymentMethod(Document):
	def on_trash(self):
		if self.system_method:
			frappe.throw(_("Системный способ оплаты нельзя удалить"))
