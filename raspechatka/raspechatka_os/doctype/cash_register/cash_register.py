from frappe.model.document import Document
from frappe.model.naming import make_autoname


class CashRegister(Document):
	def before_insert(self):
		if not self.register_code:
			self.register_code = make_autoname("CASH-.#####")
