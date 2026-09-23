import frappe
from frappe.model.document import Document


class PointSupplyRequest(Document):
	def validate(self):
		if self.item and not self.item_name:
			self.item_name = frappe.db.get_value("Catalog Item", self.item, "item_name")
		if not self.item_name:
			frappe.throw("Укажите, что требуется точке")
		if self.quantity <= 0:
			frappe.throw("Количество должно быть больше нуля")
		if self.source_pos_event:
			if self.quantity != 1:
				frappe.throw("Количество POS-запроса задаётся сервером")
			if not (self.comment or "").strip():
				frappe.throw("Комментарий обязателен")
