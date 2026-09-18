import frappe


def execute():
	"""Keep the legacy shadow writable until an administrator explicitly freezes it."""
	settings = frappe.get_single("Club Shadow Settings")
	changed = False
	for fieldname in ("frozen", "direct_cutover_enabled"):
		if settings.get(fieldname) is None:
			settings.set(fieldname, 0)
			changed = True
	if changed:
		settings.save(ignore_permissions=True)
