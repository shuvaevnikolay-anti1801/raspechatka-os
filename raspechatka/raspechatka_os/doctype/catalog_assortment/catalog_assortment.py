import frappe
from frappe import _
from frappe.model.document import Document


class CatalogAssortment(Document):
	def validate(self):
		# DEV-080: ``enabled`` is the canonical POS-sale flag. Keep the legacy
		# field mirrored until all installed clients have migrated.
		self.visible_in_pos = 1 if self.enabled else 0
		if self.valid_from and self.valid_upto and self.valid_from > self.valid_upto:
			frappe.throw(_("Дата окончания ассортимента не может быть раньше даты начала."))

		duplicate = frappe.db.exists(
			"Catalog Assortment",
			{"item": self.item, "business_point": self.business_point, "name": ["!=", self.name]},
		)
		if duplicate:
			frappe.throw(_("Для этого товара и точки настройка ассортимента уже существует."))
