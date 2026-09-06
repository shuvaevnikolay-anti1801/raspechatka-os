import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, get_datetime, now_datetime


class CashMovement(Document):
	def before_insert(self):
		self.posting_datetime = self.posting_datetime or now_datetime()

	def validate(self):
		if flt(self.amount) <= 0 or not (self.reason or "").strip():
			frappe.throw(_("Укажите положительную сумму и основание"))
		shift = frappe.db.get_value("Sales Shift", self.shift, ["business_entity", "business_point", "cashier", "opened_at", "closed_at"], as_dict=True)
		if not shift or (shift.business_entity, shift.business_point) != (self.business_entity, self.business_point):
			frappe.throw(_("Кассовая операция должна относиться к выбранной смене"))
		if shift.cashier and self.cashier != shift.cashier:
			frappe.throw(_("Кассир операции должен совпадать с кассиром смены"))
		posting = get_datetime(self.posting_datetime)
		if posting < get_datetime(shift.opened_at) or (shift.closed_at and posting > get_datetime(shift.closed_at)):
			frappe.throw(_("Время операции должно находиться внутри смены"))
		if self.movement_type == "Deposit":
			self.from_cash, self.to_cash = "Касса ИП", "Касса точки"
		else:
			self.from_cash, self.to_cash = "Касса точки", "Касса ИП"

	def before_submit(self): self.status = "Posted"
	def before_cancel(self): self.status = "Cancelled"

	def on_submit(self):
		from raspechatka.sales import log_cashier_action, update_shift_totals
		log_cashier_action(self, "DEPOSIT" if self.movement_type == "Deposit" else "WITHDRAWAL")
		update_shift_totals(self.shift)

	def on_cancel(self):
		from raspechatka.sales import log_cashier_action, update_shift_totals
		log_cashier_action(self, "CANCEL_CASH_MOVEMENT")
		update_shift_totals(self.shift)
