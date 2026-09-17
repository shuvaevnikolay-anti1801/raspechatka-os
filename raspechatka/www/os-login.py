import frappe

no_cache = 1


def get_context(context):
	if frappe.session.user != "Guest":
		frappe.local.flags.redirect_location = "/raspechatka"
		raise frappe.Redirect
	context.no_header = True
	context.no_cache = True
	context.full_width = True
	context.title = "Вход — Распечатка OS"
	return context
