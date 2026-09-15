import frappe
from frappe import _

CASHIER_ROLE = "Raspechatka Cashier"
CASHIER_ALLOWED_METHODS = {
	"login",
	"logout",
	"raspechatka.api.pos_v2.get_bootstrap",
	"raspechatka.api.pos_v2.push_events",
	"raspechatka.api.receipt_search.search_receipts",
}
PRIVILEGED_ROLES = {"System Manager", "Raspechatka Network Admin"}


def is_cashier_pos_only(user):
	"""Return whether this account is an active, employee-linked POS cashier."""
	if not user or user in {"Guest", "Administrator"}:
		return False
	if PRIVILEGED_ROLES.intersection(frappe.get_roles(user)):
		return False
	linked_employee = frappe.db.get_value(
		"Raspechatka User Profile",
		{
			"system_user": user,
			"active": 1,
			"access_profile": CASHIER_ROLE,
		},
		"linked_employee",
	)
	return bool(linked_employee)


def enforce_cashier_pos_only():
	"""Keep authenticated cashier accounts outside Web OS and non-POS APIs."""
	user = getattr(frappe.session, "user", None)
	if not is_cashier_pos_only(user):
		return

	request = getattr(frappe.local, "request", None)
	path = (getattr(request, "path", None) or "").rstrip("/")
	method = str((getattr(frappe.local, "form_dict", None) or {}).get("cmd") or "").strip()
	if path.startswith("/api/method/"):
		method = method or path.removeprefix("/api/method/")
	if method in CASHIER_ALLOWED_METHODS or path in {"/login", "/logout"}:
		return
	frappe.throw(
		_("Учётная запись кассира доступна только в Windows POS"),
		frappe.PermissionError,
	)
