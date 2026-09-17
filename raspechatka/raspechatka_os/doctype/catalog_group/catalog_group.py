import frappe
from frappe import _
from frappe.model.document import Document


class CatalogGroup(Document):
	def validate(self):
		if self.parent_catalog_group == self.name:
			frappe.throw(_("Группа не может быть родителем самой себя."))
		if self.parent_catalog_group:
			if not frappe.db.get_value("Catalog Group", self.parent_catalog_group, "active"):
				frappe.throw(_("Нельзя поместить группу в архивную группу."))
			pending = [self.parent_catalog_group]
			seen = set()
			while pending:
				parent = pending.pop()
				if parent == self.name:
					frappe.throw(_("Группу нельзя поместить внутрь собственной подгруппы."))
				if parent in seen:
					continue
				seen.add(parent)
				next_parent = frappe.db.get_value("Catalog Group", parent, "parent_catalog_group")
				if next_parent:
					pending.append(next_parent)

	def on_trash(self):
		frappe.throw(_("Группы каталога нельзя удалять. Используйте действие «В архив»."))

