import frappe

from raspechatka.security import is_cashier_pos_only

no_cache = 1


def get_context():
	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?redirect-to=/raspechatka"
		redirect = frappe.Redirect()
		redirect.http_status_code = 302
		raise redirect
	if is_cashier_pos_only(frappe.session.user):
		frappe.throw("Учётная запись кассира доступна только в Windows POS", frappe.PermissionError)

	return {"boot": get_boot()}


def get_boot():
	from raspechatka.access import get_access_level, get_access_pages, get_scope

	user = frappe.get_cached_doc("User", frappe.session.user)
	roles = frappe.get_roles(frappe.session.user)
	system_timezone = frappe.db.get_single_value("System Settings", "time_zone") or "UTC"
	# Frappe's user preference is authoritative when set; otherwise use the
	# site/system timezone. Keep the effective value explicit for Web OS clients.
	effective_user_timezone = user.time_zone or system_timezone
	pages = get_access_pages()
	page_areas = [page["area"] for page in pages]
	legacy_areas = [page.get("legacy_area") for page in pages if page.get("legacy_area")]
	areas = tuple(dict.fromkeys(page_areas + legacy_areas))
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
		"system_timezone": system_timezone,
		"effective_user_timezone": effective_user_timezone,
		# Compatibility alias consumed by older Web OS modules.
		"user_timezone": effective_user_timezone,
		"access": access,
		"scope": scope,
	}
