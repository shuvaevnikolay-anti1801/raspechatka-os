import frappe
from frappe import _
from frappe.model.document import Document


class BankOperation(Document):
	def before_insert(self):
		if frappe.db.exists("Bank Operation", {"operation_key": self.operation_key}):
			frappe.throw(_("Эта банковская операция уже загружена"))

	def validate(self):
		stored = None if self.is_new() else frappe.db.get_value("Bank Operation", self.name, "raw_payload")
		if stored is not None and stored != self.raw_payload:
			frappe.throw(_("Исходные данные банковской операции нельзя изменять"))
