import frappe
from frappe import _
from frappe.model.document import Document
from frappe.model.naming import make_autoname
from frappe.utils import flt


WEEKDAYS = ("Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье")


class BusinessPoint(Document):
	def before_insert(self):
		if not self.point_code:
			self.point_code = make_autoname("POINT-.#####")
		if not self.working_hours:
			for weekday in WEEKDAYS:
				self.append("working_hours", {
					"weekday": weekday,
					"is_working": weekday not in ("Суббота", "Воскресенье"),
					"opens_at": "09:00:00" if weekday not in ("Суббота", "Воскресенье") else None,
					"closes_at": "20:00:00" if weekday not in ("Суббота", "Воскресенье") else None,
				})

	def validate(self):
		if self.business_entity:
			self.organization = frappe.db.get_value("Business Entity", self.business_entity, "organization")

		weekdays = [row.weekday for row in self.working_hours]
		if len(weekdays) != len(set(weekdays)):
			frappe.throw(_("Каждый день недели можно указать только один раз"))

		for row in self.working_hours:
			if row.is_working and row.opens_at and row.closes_at and row.opens_at >= row.closes_at:
				frappe.throw(_("Время закрытия должно быть позже времени открытия: {0}").format(row.weekday))

		if self.allow_discounts and not 0 <= flt(self.max_discount_percent) <= 100:
			frappe.throw(_("Максимальная скидка должна быть от 0 до 100%"))

		for fieldname in ("card_bank_account", "qr_bank_account"):
			account = self.get(fieldname)
			if account and frappe.db.get_value("Business Bank Account", account, "business_entity") != self.business_entity:
				frappe.throw(_("Выбранный банковский счёт должен принадлежать ИП точки"))

	def after_insert(self):
		if not frappe.db.exists("Catalog Warehouse", {"business_point": self.name}):
			frappe.get_doc({
				"doctype": "Catalog Warehouse",
				"warehouse_name": f"Склад — {self.point_name}",
				"business_point": self.name,
				"active": self.active,
			}).insert(ignore_permissions=True)

	def on_update(self):
		warehouse = frappe.db.get_value("Catalog Warehouse", {"business_point": self.name}, "name")
		if warehouse:
			frappe.db.set_value("Catalog Warehouse", warehouse, {
				"warehouse_name": f"Склад — {self.point_name}",
				"active": self.active,
			}, update_modified=False)
