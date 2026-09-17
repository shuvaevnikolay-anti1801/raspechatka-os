import frappe
from frappe.model.document import Document

class POSOrder(Document):
	def validate(self):
		self.total_amount = sum((frappe.utils.flt(x.amount) for x in self.items), 0)
		self.payment_status = "Paid" if frappe.utils.flt(self.paid_amount) >= self.total_amount else ("Partial" if self.paid_amount else "Unpaid")

