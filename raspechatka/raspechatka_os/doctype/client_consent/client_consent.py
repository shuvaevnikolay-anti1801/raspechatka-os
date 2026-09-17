import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime


class ClientConsent(Document):
	def before_insert(self):
		self.recorded_at = self.recorded_at or now_datetime()

	def validate(self):
		if not self.is_new():
			frappe.throw(_("Записи согласий нельзя изменять"))

	def on_trash(self):
		frappe.throw(_("Записи согласий нельзя удалять"))
