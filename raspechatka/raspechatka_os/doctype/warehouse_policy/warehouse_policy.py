import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint


class WarehousePolicy(Document):
	def validate(self):
		analysis = cint(self.analysis_days)
		minimum = cint(self.minimum_days)
		target = cint(self.target_days)
		if analysis <= 0 or minimum <= 0 or target < minimum:
			frappe.throw(
				_("Период анализа и минимальный запас должны быть больше нуля, а целевой период — не меньше минимального.")
			)
