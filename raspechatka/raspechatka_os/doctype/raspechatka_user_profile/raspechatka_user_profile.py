# ruff: noqa: RUF001
import frappe
from frappe import _
from frappe.model.document import Document

ROLE_BY_PROFILE = {
	"Network Admin": "Raspechatka Network Admin",
	"Franchise Owner": "Raspechatka Franchise Owner",
	"Point Manager": "Raspechatka Point Manager",
	"Cashier": "Raspechatka Cashier",
}


def normalize_phone(value):
	from raspechatka.api.auth import normalize_login_phone

	return normalize_login_phone(value)


class RaspechatkaUserProfile(Document):
	def validate(self):
		self.access_profile = ROLE_BY_PROFILE.get(self.access_profile, self.access_profile)
		from raspechatka.access import get_matrix_roles

		if self.access_profile not in get_matrix_roles():
			frappe.throw(_("Выберите действующую рабочую роль"))
		self.full_name = " ".join(filter(None, (self.last_name, self.first_name, self.middle_name))).strip()
		self.phone = normalize_phone(self.phone)
		self._validate_scope()
		self._validate_points()
		if self.access_profile == "Raspechatka Cashier" and not self.linked_employee:
			frappe.throw(_("Для работы в кассе выберите связанного сотрудника"))
		if self.linked_employee:
			duplicate = frappe.db.get_value(
				"Raspechatka User Profile",
				{"linked_employee": self.linked_employee, "name": ["!=", self.name]},
				"name",
			)
			if duplicate:
				frappe.throw(_("Сотрудник уже связан с другим пользователем"))  # noqa: RUF001

	def after_insert(self):
		self.ensure_system_user()

	def on_update(self):
		self.ensure_system_user()

	def _validate_scope(self):
		if self.access_profile == "Raspechatka Network Admin":
			self.scope_type = "Network"
		if self.access_profile == "Raspechatka Franchise Owner" and self.scope_type != "Partner":
			frappe.throw(_("Для владельца партнёра выберите область доступа «Партнёр»"))
		if self.scope_type not in {"Network", "Partner", "Business Entity", "Points"}:
			frappe.throw(_("Выберите допустимую область доступа"))
		if self.scope_type == "Network":
			self.organization = None
			self.business_entity = None
			self.set("assigned_points", [])
			return
		if not self.organization:
			frappe.throw(_("Выберите партнёра"))
		if not frappe.db.get_value("Organization", self.organization, "active"):
			frappe.throw(_("Выбранный партнёр неактивен или не существует"))
		if self.scope_type == "Partner":
			self.business_entity = None
			self.set("assigned_points", [])
			return
		if not self.business_entity:
			frappe.throw(_("Выберите юридическое лицо"))
		entity = frappe.db.get_value(
			"Business Entity", self.business_entity, ["organization", "active"], as_dict=True
		)
		if not entity or not entity.active:
			frappe.throw(_("Выбранное юридическое лицо неактивно или не существует"))
		if entity.organization != self.organization:
			frappe.throw(_("Юридическое лицо должно относиться к выбранному партнёру"))
		if self.scope_type == "Business Entity":
			self.set("assigned_points", [])
			return
		if self.scope_type == "Points" and not self.assigned_points:
			frappe.throw(_("Выберите хотя бы одну точку продаж"))

	def _validate_points(self):
		points = [row.business_point for row in self.assigned_points]
		if len(points) != len(set(points)):
			frappe.throw(_("Точку можно назначить пользователю только один раз"))
		if sum(int(row.is_default or 0) for row in self.assigned_points) > 1:
			frappe.throw(_("Основной может быть только одна точка"))
		if self.scope_type != "Points":
			return
		for point in points:
			values = frappe.db.get_value("Business Point", point, ["business_entity", "active"], as_dict=True)
			if not values or not values.active:
				frappe.throw(_("Выбранная точка неактивна или не существует"))
			if values.business_entity != self.business_entity:
				frappe.throw(_("Все выбранные точки должны относиться к выбранному юридическому лицу"))

	def ensure_system_user(self):
		system_user = self.system_user
		if not system_user:
			system_user = frappe.db.get_value("User", {"username": self.phone}, "name")
		if not system_user:
			digits = self.phone.removeprefix("+")
			email = f"u{digits}@users.raspechatka.internal"
			if frappe.db.exists("User", email):
				system_user = email
			else:
				user_doc = frappe.get_doc(
					{
						"doctype": "User",
						"email": email,
						"username": self.phone,
						"first_name": self.first_name,
						"last_name": self.last_name,
						"enabled": self.active,
						"send_welcome_email": 0,
						"user_type": "System User",
					}
				)
				user_doc.insert(ignore_permissions=True)
				system_user = user_doc.name

		user_doc = frappe.get_doc("User", system_user)
		phone_owner = frappe.db.get_value(
			"User", {"username": self.phone, "name": ["!=", system_user]}, "name"
		)
		if phone_owner:
			frappe.throw(_("Этот номер телефона уже используется для входа"))

		user_doc.username = self.phone
		user_doc.first_name = self.first_name
		user_doc.last_name = self.last_name or ""
		user_doc.enabled = self.active
		from raspechatka.access import get_matrix_roles

		managed_roles = set(get_matrix_roles()) | set(ROLE_BY_PROFILE.values())
		user_doc.roles = [row for row in user_doc.roles if row.role not in managed_roles]
		user_doc.append("roles", {"role": self.access_profile})
		user_doc.save(ignore_permissions=True)
		if self.system_user != system_user:
			frappe.db.set_value(
				"Raspechatka User Profile",
				self.name,
				"system_user",
				system_user,
				update_modified=False,
			)
