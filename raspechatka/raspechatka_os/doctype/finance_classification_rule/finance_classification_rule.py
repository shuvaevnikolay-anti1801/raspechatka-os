import re

import frappe
from frappe import _
from frappe.model.document import Document


class FinanceClassificationRule(Document):
	def validate(self):
		if self.purpose_regex:
			try:
				re.compile(self.purpose_regex)
			except re.error as error:
				frappe.throw(_("Некорректное регулярное выражение: {0}").format(error))
		if self.financial_article:
			if self.result == "Approve" and self.direction not in ("Income", "Expense"):
				frappe.throw(_("Для автоматического учёта выберите направление «Приход» или «Расход»"))
			article = frappe.db.get_value(
				"Financial Article",
				self.financial_article,
				["article_type", "active", "is_group"],
				as_dict=True,
			)
			if not article or not article.active or article.is_group:
				frappe.throw(_("Правило должно использовать активную конечную финансовую статью"))
			if self.direction in ("Income", "Expense") and article.article_type != self.direction:
				frappe.throw(_("Направление правила не соответствует типу финансовой статьи"))
		if self.result == "Approve" and not self.financial_article:
			frappe.throw(_("Для автоматического учёта выберите финансовую статью"))
		if (
			self.business_point
			and self.business_entity
			and frappe.db.get_value("Business Point", self.business_point, "business_entity") != self.business_entity
		):
			frappe.throw(_("Точка продаж не относится к выбранному ИП"))

	def on_trash(self):
		frappe.throw(_("Правила обработки нельзя удалять. Отключите правило."))
