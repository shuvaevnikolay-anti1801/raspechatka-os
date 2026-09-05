import re

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime


class Client(Document):
	def before_insert(self):
		self.registered_by = frappe.session.user
		self.registered_at = now_datetime()

	def validate(self):
		self.phone = re.sub(r"\D", "", self.phone or "")
		if not 10 <= len(self.phone) <= 15:
			frappe.throw(_("Телефон клиента должен содержать от 10 до 15 цифр"))
		self.client_name = " ".join(filter(None, (self.last_name, self.first_name, self.middle_name))).strip()
		if self.personal_data_consent and not self.personal_data_consent_at:
			self.personal_data_consent_at = now_datetime()
		if not self.personal_data_consent:
			self.personal_data_consent_at = None
		if self.marketing_consent and not self.marketing_consent_at:
			self.marketing_consent_at = now_datetime()
		if not self.marketing_consent:
			self.marketing_consent_at = None
