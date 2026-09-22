import frappe

from raspechatka.time_contract import get_effective_site_timezone


LEGACY_FRAPPE_FALLBACK = "Asia/Kolkata"
CANONICAL_SITE_TIMEZONE = "Europe/Moscow"


def execute():
	"""Drop the accidental legacy Frappe timezone from existing users after DEV-161."""
	if get_effective_site_timezone() != CANONICAL_SITE_TIMEZONE:
		return

	users = frappe.get_all(
		"User",
		filters={"time_zone": LEGACY_FRAPPE_FALLBACK},
		pluck="name",
		limit_page_length=100000,
	)
	for user in users:
		frappe.db.set_value(
			"User",
			user,
			"time_zone",
			"",
			update_modified=False,
		)

	if users:
		frappe.clear_cache()
