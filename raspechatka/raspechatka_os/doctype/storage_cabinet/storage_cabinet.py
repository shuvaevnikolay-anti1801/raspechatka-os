import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint


class StorageCabinet(Document):
	def validate(self):
		self.cabinet_number = cint(self.cabinet_number)
		if self.cabinet_number < 1:
			frappe.throw(_("Номер шкафа должен быть больше нуля"))
		self.cabinet_name = f"Шкаф {self.cabinet_number}"
		existing = frappe.db.get_value(
			"Storage Cabinet",
			{"warehouse": self.warehouse, "cabinet_number": self.cabinet_number},
			"name",
		)
		if existing and existing != self.name:
			frappe.throw(_("Шкаф с таким номером уже существует на этом складе"))
