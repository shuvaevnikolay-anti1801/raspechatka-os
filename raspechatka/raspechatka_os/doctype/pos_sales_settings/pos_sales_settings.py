from math import isfinite

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class POSSalesSettings(Document):
	def validate(self):
		if not 0 <= flt(self.max_discount_percent) <= 100:
			frappe.throw(_("Максимальная скидка должна быть от 0 до 100%"))
		lower = flt(self.markup_lower_threshold)
		upper = flt(self.markup_upper_threshold)
		if not isfinite(lower) or not isfinite(upper) or lower < 0 or upper < 0 or lower >= upper:
			frappe.throw(_("Границы наценки должны быть неотрицательными, нижняя — меньше верхней."))
