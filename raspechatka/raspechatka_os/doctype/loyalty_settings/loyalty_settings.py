import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt


class LoyaltySettings(Document):
	def validate(self):
		seen = set()
		for row in self.discount_rules:
			count = cint(row.active_channel_count)
			if count < 0 or count > cint(self.max_active_channels or 2):
				frappe.throw(_("Некорректное число каналов в правиле скидки"))
			if count in seen:
				frappe.throw(_("Для {0} каналов задано несколько правил").format(count))
			if flt(row.discount_percent) < 0 or flt(row.discount_percent) > flt(self.maximum_discount_percent):
				frappe.throw(_("Скидка в правиле превышает разрешённый максимум"))
			seen.add(count)
