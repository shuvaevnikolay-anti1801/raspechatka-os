import frappe
from frappe import _
from frappe.model.document import Document


class CatalogPriceType(Document):
	def validate(self):
		if not self.active and frappe.db.exists("Business Point", {"default_price_type": self.name, "active": 1}):
			frappe.throw(_("Вид цены используется активной точкой продаж."))

	def on_trash(self):
		frappe.throw(\n\t\t\t_("Виды цен нельзя удалять. Отключите вид цены после замены его во всех точках.")\n\t\t)
