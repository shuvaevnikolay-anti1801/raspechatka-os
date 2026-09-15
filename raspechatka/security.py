import frappe
from frappe import _


CASHIER_ROLE = "Raspechatka Cashier"
CASHIER_ALLOWED_METHODS = {
	"logout",
	"raspechatka.api.pos.get_bootstrap",
	"raspechatka.api.pos.push_events",
}


def enforce_cashier_pos_only():
	"""Keep authenticated cashier accounts outside Web OS and non-POS APIs."""
	user = getattr(frappe.session, "user", None)
	if not user or user == "Guest" or CASHIER_ROLE not in set(frappe.get_roles(user)):
		return

	request = getattr(frappe.local, "request", None)
	path = (getattr(request, "path", None) or "").rstrip("/")
	method = str((getattr(frappe.local, "form_dict", None) or {}).get("cmd") or "").strip()
	if path.startswith("/api/method/"):
		method = method or path.removeprefix("/api/method/")
	if method in CASHIER_ALLOWED_METHODS:
		return
	frappe.throw(
		_("Учётная запись кассира доступна только в Windows POS"),
		frappe.PermissionError,
	)
