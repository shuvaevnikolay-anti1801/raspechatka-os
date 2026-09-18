import frappe

from raspechatka.api.auth import normalize_login_phone

CASHIER_ROLE = "Raspechatka Cashier"


def _canonical_phone(value):
	return normalize_login_phone(value, throw=False)


def execute():
	if not frappe.db.exists("DocType", "Raspechatka User Profile") or not frappe.db.exists(
		"DocType", "Employee"
	):
		return

	profiles = frappe.get_all(
		"Raspechatka User Profile",
		filters={"active": 1, "access_profile": CASHIER_ROLE},
		fields=[
			"name",
			"phone",
			"system_user",
			"linked_employee",
			"business_entity",
		],
		limit_page_length=0,
	)
	if not profiles:
		return

	# The profile is the source of truth for login state. Re-sync the backing User
	# first so old/incomplete profiles are not rejected by POS only because their
	# generated Frappe account drifted out of sync.
	for profile in profiles:
		doc = frappe.get_doc("Raspechatka User Profile", profile.name)
		doc.ensure_system_user()
		profile.system_user = frappe.db.get_value(
			"Raspechatka User Profile", profile.name, "system_user"
		)

	all_profiles = frappe.get_all(
		"Raspechatka User Profile",
		filters={"linked_employee": ["is", "set"]},
		fields=["name", "linked_employee"],
		limit_page_length=0,
	)
	claimed = {row.linked_employee: row.name for row in all_profiles if row.linked_employee}

	employees = frappe.get_all(
		"Employee",
		filters={"active": 1},
		fields=["name", "phone", "business_entity", "system_user_profile", "user"],
		limit_page_length=0,
	)
	by_name = {row.name: row for row in employees}

	def available(employee, profile_name):
		if not employee:
			return False
		owner = claimed.get(employee.name)
		return (not owner or owner == profile_name) and (
			not employee.system_user_profile or employee.system_user_profile == profile_name
		)

	for profile in profiles:
		linked = by_name.get(profile.linked_employee) if profile.linked_employee else None
		if linked and available(linked, profile.name):
			if linked.system_user_profile != profile.name:
				frappe.db.set_value(
					"Employee", linked.name, "system_user_profile", profile.name, update_modified=False
				)
			continue

		candidates = [
			row
			for row in employees
			if row.system_user_profile == profile.name and available(row, profile.name)
		]
		if not candidates and profile.system_user:
			candidates = [
				row
				for row in employees
				if row.user == profile.system_user and available(row, profile.name)
			]
		if not candidates and profile.phone and profile.business_entity:
			phone = _canonical_phone(profile.phone)
			if phone:
				candidates = [
					row
					for row in employees
					if row.business_entity == profile.business_entity
					and _canonical_phone(row.phone) == phone
					and available(row, profile.name)
				]

		# Never guess when historical data gives more than one possible employee.
		if len(candidates) != 1:
			continue
		employee = candidates[0]
		frappe.db.set_value(
			"Raspechatka User Profile",
			profile.name,
			"linked_employee",
			employee.name,
			update_modified=False,
		)
		if employee.system_user_profile != profile.name:
			frappe.db.set_value(
				"Employee", employee.name, "system_user_profile", profile.name, update_modified=False
			)
		claimed[employee.name] = profile.name
