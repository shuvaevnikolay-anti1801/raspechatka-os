import frappe

from raspechatka.api.auth import normalize_login_phone


def execute():
	if not frappe.db.exists("DocType", "Raspechatka User Profile"):
		return

	profiles = frappe.get_all(
		"Raspechatka User Profile",
		fields=["name", "phone", "system_user"],
		limit_page_length=0,
	)
	by_phone = {}
	for profile in profiles:
		canonical = normalize_login_phone(profile.phone, throw=False)
		if canonical:
			by_phone.setdefault(canonical, []).append(profile)

	for canonical, matches in by_phone.items():
		# Never guess which account owns a duplicate historical identity.
		if len(matches) != 1:
			continue
		profile = matches[0]
		if profile.phone != canonical:
			frappe.db.set_value(
				"Raspechatka User Profile", profile.name, "phone", canonical, update_modified=False
			)
		if not profile.system_user or not frappe.db.exists("User", profile.system_user):
			continue
		owner = frappe.db.get_value(
			"User",
			{"username": canonical, "name": ["!=", profile.system_user]},
			"name",
		)
		if not owner:
			frappe.db.set_value("User", profile.system_user, "username", canonical, update_modified=False)
