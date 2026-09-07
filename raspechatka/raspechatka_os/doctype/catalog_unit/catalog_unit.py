import frappe
from frappe import _
from frappe.model.document import Document


ALLOWED_UNITS = {"шт", "мес"}


class CatalogUnit(Document):
	def validate(self):
		if self.unit_name not in ALLOWED_UNITS:
			frappe.throw(_("В системе используются только единицы измерения «шт» и «мес»."))
		self.symbol = self.unit_name
		self.allow_fraction = 0
		self.active = 1

	def on_trash(self):
		frappe.throw(_("Системные единицы измерения нельзя удалить."))

