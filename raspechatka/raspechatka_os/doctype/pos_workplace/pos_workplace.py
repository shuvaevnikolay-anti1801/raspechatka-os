from frappe.model.document import Document
from frappe.model.naming import make_autoname


class POSWorkplace(Document):
	def before_insert(self):
		if not self.workplace_code:
			self.workplace_code = make_autoname("POS-.#####")
