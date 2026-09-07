import frappe
from frappe import _
from frappe.model.document import Document

from raspechatka.requisites import digits, is_valid_inn, is_valid_ogrnip


class BusinessEntity(Document):
	def before_insert(self):
		self.active = 1
		if not self.internal_code:
			self.internal_code = _new_internal_code()

	def validate(self):
		self.inn = digits(self.inn)
		self.ogrnip = digits(self.ogrnip)
		self.okpo = digits(self.okpo)

		if not is_valid_inn(self.inn) or len(self.inn) != 12:
			frappe.throw(_("Укажите корректный 12-значный ИНН индивидуального предпринимателя"))
		if self.ogrnip and not is_valid_ogrnip(self.ogrnip):
			frappe.throw(_("Укажите корректный 15-значный ОГРНИП"))

	def on_trash(self):
		frappe.throw(_("ИП нельзя удалить. Переведите карточку в архив."))


def _new_internal_code():
	while True:
		value = f"IP-{frappe.generate_hash(length=12).upper()}"
		if not frappe.db.exists("Business Entity", {"internal_code": value}):
			return value
