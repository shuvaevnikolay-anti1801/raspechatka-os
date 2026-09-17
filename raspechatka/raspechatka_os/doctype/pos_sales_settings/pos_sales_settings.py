import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class POSSalesSettings(Document):
	def validate(self):
		if not 0 <= flt(self.max_discount_percent) <= 100:
			frappe.throw(_("Максимальная скидка должна быть от 0 до 100%"))
