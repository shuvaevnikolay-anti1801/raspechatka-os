import frappe
from frappe import _
from frappe.model.document import Document


class StorageLocation(Document):
	def validate(self):
		cabinet = frappe.db.get_value("Storage Cabinet", self.cabinet, ["warehouse", "cabinet_name"], as_dict=True)
		if not cabinet:
			frappe.throw(_("Выбранный шкаф не найден"))

		self.warehouse = cabinet.warehouse
		self.location_name = (self.location_name or "").strip()
		self.full_address = f"{cabinet.cabinet_name} — {self.location_name}"
		existing = frappe.db.get_value(
			"Storage Location",
			{"cabinet": self.cabinet, "location_name": self.location_name},
			"name",
		)
		if existing and existing != self.name:
			frappe.throw(_("Место с таким названием уже существует в выбранном шкафу"))
