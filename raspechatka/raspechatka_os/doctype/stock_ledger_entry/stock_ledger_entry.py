import frappe
from frappe import _
from frappe.model.document import Document


class StockLedgerEntry(Document):
	def validate(self):
		if not self.is_new():
			frappe.throw(_("Складские движения нельзя изменять."))

	def on_trash(self):
		frappe.throw(_("Складские движения нельзя удалять."))
