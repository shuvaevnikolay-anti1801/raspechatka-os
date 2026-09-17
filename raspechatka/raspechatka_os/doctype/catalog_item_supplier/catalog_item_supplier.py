import frappe
from frappe import _
from frappe.model.document import Document


class CatalogItemSupplier(Document):
	def validate(self):
		existing = frappe.db.get_value("Catalog Item Supplier", {"item": self.item, "supplier": self.supplier}, "name")
		if existing and existing != self.name:
			frappe.throw(_("Этот поставщик уже связан с товаром"))
		if self.is_primary:
			frappe.db.set_value("Catalog Item Supplier", {"item": self.item, "is_primary": 1}, "is_primary", 0, update_modified=False)
			frappe.db.set_value("Catalog Item", self.item, "default_supplier", self.supplier, update_modified=False)
