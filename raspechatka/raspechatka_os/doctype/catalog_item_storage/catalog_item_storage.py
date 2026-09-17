import frappe
from frappe import _
from frappe.model.document import Document


class CatalogItemStorage(Document):
	def validate(self):
		location = frappe.db.get_value("Storage Location", self.storage_location, ["warehouse", "full_address"], as_dict=True)
		if not location or location.warehouse != self.warehouse:
			frappe.throw(_("Место хранения должно принадлежать выбранному складу"))
		self.full_address = location.full_address

		existing = frappe.db.get_value(
			"Catalog Item Storage",
			{"item": self.item, "warehouse": self.warehouse},
			"name",
		)
		if existing and existing != self.name:
			frappe.throw(_("Для товара уже указан адрес на этом складе"))
