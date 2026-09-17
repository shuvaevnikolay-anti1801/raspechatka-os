import re

import frappe
from frappe import _
from frappe.rate_limiter import rate_limit

from raspechatka.access_contract import access_contract

INVALID_CREDENTIALS = "Неверный номер телефона или пароль"
INACTIVE_ACCOUNT = "Ваш аккаунт отключён. Обратитесь к руководителю"


def normalize_login_phone(value, *, throw=True):
	"""Return one canonical Russian login identity: +7XXXXXXXXXX."""
	digits = re.sub(r"\D", "", value or "")
	if len(digits) == 10:
		digits = "7" + digits
	elif len(digits) == 11 and digits.startswith("8"):
		digits = "7" + digits[1:]
	if len(digits) == 11 and digits.startswith("7"):
		return "+" + digits
	if throw:
		frappe.throw(_("Введите корректный номер телефона"), frappe.ValidationError)
	return None


def _profile_for_phone(phone):
	"""Resolve canonical and legacy-formatted profile phones without trusting User.username."""
	canonical = normalize_login_phone(phone)
	profiles = frappe.get_all(
		"Raspechatka User Profile",
		filters={"phone": canonical},
		fields=["name", "phone", "system_user", "active"],
		limit_page_length=2,
	)
	if not profiles:
		profiles = frappe.get_all(
			"Raspechatka User Profile",
			fields=["name", "phone", "system_user", "active"],
			limit_page_length=0,
		)
	matches = [row for row in profiles if normalize_login_phone(row.phone, throw=False) == canonical]
	# Ambiguous historical data must never select an arbitrary account.
	return matches[0] if len(matches) == 1 else None


def _authentication_error(message=INVALID_CREDENTIALS):
	frappe.flags.disable_traceback = True
	frappe.throw(_(message), frappe.AuthenticationError)


@frappe.whitelist(allow_guest=True, methods=["POST"])
@access_contract(auth="guest", scope="none")
@rate_limit(limit=10, seconds=60, methods=["POST"], ip_based=True)
def login(phone, password):
	"""Authenticate Web OS by profile phone while retaining Frappe password/session security."""
	# Request/error instrumentation may inspect form_dict; never retain the password there.
	frappe.form_dict.pop("password", None)
	if not phone:
		frappe.throw(_("Введите номер телефона"), frappe.ValidationError)
	if not password:
		frappe.throw(_("Введите пароль"), frappe.ValidationError)

	profile = _profile_for_phone(phone)
	if not profile or not profile.system_user:
		# Use Frappe's tracker even for an unknown public identity.
		try:
			frappe.local.login_manager.authenticate(user=normalize_login_phone(phone), pwd=password)
		except frappe.AuthenticationError:
			_authentication_error()
		_authentication_error()

	if not profile.active or not frappe.db.get_value("User", profile.system_user, "enabled"):
		_authentication_error(INACTIVE_ACCOUNT)

	try:
		frappe.local.login_manager.authenticate(user=profile.system_user, pwd=password)
		frappe.local.login_manager.post_login()
	except frappe.AuthenticationError:
		_authentication_error()

	frappe.db.set_value(
		"Raspechatka User Profile",
		profile.name,
		"invitation_status",
		"Activated",
		update_modified=False,
	)
	return {"redirect_to": "/raspechatka"}
