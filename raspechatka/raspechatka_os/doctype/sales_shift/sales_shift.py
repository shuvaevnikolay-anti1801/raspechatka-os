import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import get_datetime, now_datetime


class SalesShift(Document):
	def before_insert(self):
		self.opened_at = self.opened_at or now_datetime()

	def validate(self):
		point = frappe.db.get_value("Business Point", self.business_point, ["business_entity", "active"], as_dict=True)
		if not point or point.business_entity != self.business_entity:
			frappe.throw(_("Точка продаж не относится к выбранному ИП"))
		if frappe.db.get_value("Catalog Warehouse", self.warehouse, "business_point") != self.business_point:
			frappe.throw(_("Склад не относится к выбранной точке"))
		if self.cashier:
			employee = frappe.db.get_value("Employee", self.cashier, ["business_entity", "active"], as_dict=True)
			assigned = frappe.db.exists("Employee Point Assignment", {"parent": self.cashier, "business_point": self.business_point})
			if not employee or not employee.active or employee.business_entity != self.business_entity or not assigned:
				frappe.throw(_("Кассир не имеет доступа к выбранной точке"))
		if self.closed_at and get_datetime(self.closed_at) < get_datetime(self.opened_at):
			frappe.throw(_("Смена не может закрыться раньше открытия"))
		if not self.shift_type:
			self.shift_type = "Утро" if get_datetime(self.opened_at).hour < 14 else "Вечер"
		if self.status == "Closed" and not self.closed_at:
			frappe.throw(_("Для закрытой смены укажите время закрытия"))
		other = frappe.db.exists("Sales Shift", {"business_point": self.business_point, "status": "Open", "name": ["!=", self.name or ""]})
		if self.status == "Open" and other:
			frappe.throw(_("На точке уже есть открытая смена"))
