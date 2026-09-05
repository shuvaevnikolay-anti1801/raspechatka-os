import re

import frappe
from frappe import _
from frappe.model.document import Document


class CatalogSupplier(Document):
	def validate(self):
		for fieldname in ("inn", "kpp", "ogrn", "ogrnip"):
			self.set(fieldname, re.sub(r"\D", "", self.get(fieldname) or ""))
		if self.scope == "Business Entity" and not self.business_entity:
			frappe.throw(_("Для собственного поставщика укажите владельца-ИП"))
		if self.scope == "Network":
			self.business_entity = None
		lengths = {"Company": (10, "ogrn", 13), "Individual Entrepreneur": (12, "ogrnip", 15)}
		if self.supplier_type in lengths:
			inn_length, registry_field, registry_length = lengths[self.supplier_type]
			if self.inn and len(self.inn) != inn_length:
				frappe.throw(_("Некорректная длина ИНН поставщика"))
			if self.get(registry_field) and len(self.get(registry_field)) != registry_length:
				frappe.throw(_("Некорректная длина регистрационного номера поставщика"))
