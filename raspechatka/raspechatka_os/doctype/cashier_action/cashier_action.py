import frappe
from frappe import _
from frappe.model.document import Document


class CashierAction(Document):
	def validate(self):
		if self.action_datetime and self.business_point:
			from raspechatka.sales import set_business_date
			set_business_date(self, "action_datetime")
		if not self.is_new():
			frappe.throw(_("Журнал действий нельзя изменять"))

	def on_trash(self):
		frappe.throw(_("Журнал действий нельзя удалять"))
