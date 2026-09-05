import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime


class ClientEventLog(Document):
	def before_insert(self):
		self.event_datetime = self.event_datetime or now_datetime()

	def validate(self):
		if not self.is_new():
			frappe.throw(_("Журнал событий нельзя изменять"))

	def on_trash(self):
		frappe.throw(_("Журнал событий нельзя удалять"))
