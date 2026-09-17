import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class PromoCode(Document):
	def validate(self):
		self.code = (self.code or "").strip().upper()
		if flt(self.discount_value) <= 0:
			frappe.throw(_("Размер скидки должен быть больше нуля"))
		if self.discount_type == "Процент" and flt(self.discount_value) > 100:
			frappe.throw(_("Процентная скидка не может превышать 100%"))
		if self.valid_from and self.valid_to and self.valid_from > self.valid_to:
			frappe.throw(_("Дата окончания промокода раньше даты начала"))
