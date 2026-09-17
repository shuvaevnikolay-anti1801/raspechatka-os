import frappe
from frappe import _
from frappe.model.document import Document


class SystemAnnouncementRead(Document):
	def validate(self):
		existing = frappe.db.get_value(
			"System Announcement Read",
			{"announcement": self.announcement, "user": self.user},
			"name",
		)
		if existing and existing != self.name:
			frappe.throw(_("Уведомление уже отмечено прочитанным"))
