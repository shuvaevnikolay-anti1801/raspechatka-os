import frappe
from frappe import _
from frappe.model.document import Document


class SystemAnnouncement(Document):
	def validate(self):
		if self.published_until and self.published_from and self.published_until < self.published_from:
			frappe.throw(_("Дата окончания не может быть раньше даты публикации"))
		if self.audience in ("Role", "User") and not self.audience_value:
			frappe.throw(_("Укажите получателя уведомления"))
		if self.audience == "Role" and not frappe.db.exists("Role", self.audience_value):
			frappe.throw(_("Указанная роль не существует"))
		if self.audience == "User" and not frappe.db.exists("User", self.audience_value):
			frappe.throw(_("Указанный пользователь не существует"))
