from frappe.model.document import Document


class POSCashCount(Document):
	def validate(self):
		for row in self.lines:
			row.amount = row.denomination * row.quantity
		self.counted_amount = sum(row.amount for row in self.lines)
		self.difference = self.counted_amount - self.expected_amount
