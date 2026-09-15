import frappe

ROLE_BY_PROFILE = {
	"Network Admin": "Raspechatka Network Admin",
	"Franchise Owner": "Raspechatka Franchise Owner",
	"Point Manager": "Raspechatka Point Manager",
	"Cashier": "Raspechatka Cashier",
}


def execute():
	"""Keep old profiles valid after access_profile becomes a Link to Role."""
	if not frappe.db.exists("DocType", "Raspechatka User Profile"):
		return
	for legacy_profile, role in ROLE_BY_PROFILE.items():
		if frappe.db.exists("Role", role):
			for profile in frappe.get_all(
				"Raspechatka User Profile",
				filters={"access_profile": legacy_profile},
				pluck="name",
				limit_page_length=100000,
			):
				frappe.db.set_value(
					"Raspechatka User Profile",
					profile,
					"access_profile",
					role,
					update_modified=False,
				)
