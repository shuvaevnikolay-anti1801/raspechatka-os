import frappe
from frappe import _
from frappe.utils.nestedset import NestedSet


class FinancialArticle(NestedSet):
	def validate(self):
		previous = self.get_doc_before_save()
		if previous and previous.system_article:
			protected = ("article_name", "article_type", "active", "system_article")
			if any(self.get(field) != previous.get(field) for field in protected):
				frappe.throw(_("Системную финансовую статью нельзя изменять"))
		if self.parent_financial_article:
			parent_type = frappe.db.get_value("Financial Article", self.parent_financial_article, "article_type")
			if parent_type and parent_type != self.article_type:
				frappe.throw(_("Родительская и дочерняя статьи должны иметь одинаковый тип"))

	def on_trash(self):
		frappe.throw(_("Финансовые статьи нельзя удалять. Перенесите статью в архив."))
