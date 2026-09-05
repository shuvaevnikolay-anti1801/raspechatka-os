import frappe
from frappe import _
from frappe.model.document import Document
from frappe.model.naming import make_autoname


class CatalogWarehouse(Document):
	def before_insert(self):
		if not self.warehouse_code:
			self.warehouse_code = make_autoname("WH-.#####")

	def validate(self):
		existing = frappe.db.get_value("Catalog Warehouse", {"business_point": self.business_point}, "name")
		if existing and existing != self.name:
			frappe.throw(_("У точки продаж может быть только один склад"))
