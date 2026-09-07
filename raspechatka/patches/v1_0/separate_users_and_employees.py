import re

import frappe


def execute():
	if not frappe.db.exists("DocType", "Raspechatka User Profile"):
		return

	for employee in frappe.get_all(
		"Employee",
		fields=[
			"name",
			"last_name",
			"first_name",
			"middle_name",
			"phone",
			"email",
			"active",
			"business_entity",
			"access_profile",
			"user",
			"notes",
		],
		limit_page_length=100000,
	):
		if not employee.user and not employee.email:
			continue
		existing = None
		if employee.user:
			existing = frappe.db.get_value(
				"Raspechatka User Profile", {"system_user": employee.user}, "name"
			)
		if existing:
			_link_employee(employee.name, existing)
			continue

		phone = _migration_phone(employee)
		if not phone:
			continue
		profile = frappe.new_doc("Raspechatka User Profile")
		profile.last_name = employee.last_name
		profile.first_name = employee.first_name
		profile.middle_name = employee.middle_name
		profile.phone = phone
		profile.active = employee.active
		profile.access_profile = employee.access_profile or "Cashier"
		profile.system_user = employee.user
		profile.linked_employee = employee.name
		profile.notes = employee.notes

		assignments = frappe.get_all(
			"Employee Point Assignment",
			filters={"parent": employee.name},
			fields=["business_point", "is_default"],
		)
		if profile.access_profile == "Network Admin":
			profile.scope_type = "Network"
		elif profile.access_profile == "Franchise Owner":
			profile.scope_type = "Partner"
			profile.organization = frappe.db.get_value(
				"Business Entity", employee.business_entity, "organization"
			)
		elif assignments:
			profile.scope_type = "Points"
			for row in assignments:
				profile.append(
					"assigned_points",
					{
						"business_point": row.business_point,
						"is_default": row.is_default,
					},
				)
		else:
			profile.scope_type = "Business Entity"
			profile.business_entity = employee.business_entity

		profile.insert(ignore_permissions=True)
		_link_employee(employee.name, profile.name)


def _migration_phone(employee):
	digits = re.sub(r"\D", "", employee.phone or "")
	if len(digits) == 10:
		digits = "7" + digits
	elif len(digits) == 11 and digits.startswith("8"):
		digits = "7" + digits[1:]
	if len(digits) == 11 and digits.startswith("7"):
		return "+" + digits
	if employee.user:
		username = frappe.db.get_value("User", employee.user, "username")
		digits = re.sub(r"\D", "", username or "")
		if len(digits) == 11 and digits.startswith("7"):
			return "+" + digits
	return None


def _link_employee(employee, profile):
	frappe.db.set_value(
		"Employee",
		employee,
		"system_user_profile",
		profile,
		update_modified=False,
	)
