import frappe


no_cache = 1


def get_context():
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?redirect-to=/raspechatka"
		redirect = frappe.Redirect()
		redirect.http_status_code = 302
		raise redirect

	return {"boot": get_boot()}


def get_boot():
	from raspechatka.access import get_access_level, get_scope
	user = frappe.get_cached_doc("User", frappe.session.user)
	roles = frappe.get_roles(frappe.session.user)

	areas = ("dashboard", "references.network", "references.storage", "references.clients", "references.suppliers", "references.employees", "references.catalog", "references.finance", "clients.base", "clients.loyalty", "clients.marketing", "warehouse.operations", "finance.operations", "finance.planning", "finance.reporting", "finance.bank", "settings.access")
	try:
		access = {area: get_access_level(area) for area in areas}
		scope = get_scope()
	except Exception:
		access = {area: "Admin" if "System Manager" in roles else "None" for area in areas}
		scope = {"global": "System Manager" in roles, "business_entity": None, "points": []}

	return {
		"user": user.name,
		"full_name": user.full_name or user.name,
		"user_image": user.user_image,
		"roles": roles,
		"is_manager": "System Manager" in roles,
		"csrf_token": frappe.sessions.get_csrf_token(),
		"access": access,
		"scope": scope,
	}
