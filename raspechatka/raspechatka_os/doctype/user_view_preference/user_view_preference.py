import frappe
from frappe import _
from frappe.model.document import Document


class UserViewPreference(Document):
	def validate(self):
		existing = frappe.db.get_value(
			"User View Preference",
			{"user": self.user, "view_key": self.view_key},
			"name",
		)
		if existing and existing != self.name:
			frappe.throw(_("Настройки этого представления уже существуют для пользователя"))
