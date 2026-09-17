import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime


class ClientPurchase(Document):
	def before_insert(self):
		self.purchase_datetime = self.purchase_datetime or now_datetime()

	def validate(self):
		if not self.is_new():
			frappe.throw(_("Историю покупок нельзя изменять"))

	def on_trash(self):
		frappe.throw(_("Историю покупок нельзя удалять"))
