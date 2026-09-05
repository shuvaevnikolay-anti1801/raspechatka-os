import frappe
from frappe import _
from frappe.model.document import Document


ROLE_BY_PROFILE = {"Network Admin": "Raspechatka Network Admin", "Franchise Owner": "Raspechatka Franchise Owner", "Point Manager": "Raspechatka Point Manager", "Cashier": "Raspechatka Cashier"}


class Employee(Document):
	def validate(self):
		self.employee_name = " ".join(filter(None, (self.last_name, self.first_name, self.middle_name))).strip()
		points = [row.business_point for row in self.assigned_points]
		if len(points) != len(set(points)):
			frappe.throw(_("Точку можно назначить сотруднику только один раз"))
		if sum(row.is_default for row in self.assigned_points) > 1:
			frappe.throw(_("Основной может быть только одна точка"))
		if self.access_profile != "Network Admin":
			for point in points:
				if frappe.db.get_value("Business Point", point, "business_entity") != self.business_entity:
					frappe.throw(_("Сотруднику можно назначить только точки его ИП"))

	def after_insert(self):
		self._ensure_user()

	def on_update(self):
		self._ensure_user()

	def _ensure_user(self):
		if not self.email:
			return
		user = frappe.db.exists("User", self.email)
		if not user:
			user_doc = frappe.get_doc({"doctype": "User", "email": self.email, "first_name": self.first_name, "last_name": self.last_name, "enabled": self.active, "send_welcome_email": 0})
			user_doc.insert(ignore_permissions=True)
			user = user_doc.name
		role = ROLE_BY_PROFILE[self.access_profile]
		user_doc = frappe.get_doc("User", user)
		managed_roles = set(ROLE_BY_PROFILE.values())
		user_doc.roles = [row for row in user_doc.roles if row.role not in managed_roles]
		user_doc.append("roles", {"role": role})
		user_doc.enabled = self.active
		user_doc.save(ignore_permissions=True)
		if self.user != user:
			frappe.db.set_value("Employee", self.name, "user", user, update_modified=False)
