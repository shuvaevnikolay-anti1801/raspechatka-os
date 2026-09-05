import frappe
from frappe import _
from frappe.utils.nestedset import NestedSet


class FinancialArticle(NestedSet):
	def validate(self):
		if self.parent_financial_article:
			parent_type = frappe.db.get_value("Financial Article", self.parent_financial_article, "article_type")
			if parent_type and parent_type != self.article_type:
				frappe.throw(_("Родительская и дочерняя статьи должны иметь одинаковый тип"))

	def on_trash(self):
		if self.system_article:
			frappe.throw(_("Системную финансовую статью нельзя удалить"))
		super().on_trash()
