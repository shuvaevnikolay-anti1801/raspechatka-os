from urllib.parse import parse_qs, urlparse

import frappe
from frappe.auth import CookieManager, LoginManager
from frappe.core.doctype.user.user import update_password
from frappe.tests import IntegrationTestCase

from raspechatka.api import auth


class TestWebAuthentication(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		frappe.set_user("Administrator")

	def _guest_request(self):
		frappe.utils.set_request(path="/api/method/raspechatka.api.auth.login")
		frappe.local.request_ip = "127.0.0.78"
		frappe.local.cookie_manager = CookieManager()
		frappe.local.form_dict = frappe._dict({"cmd": "raspechatka.api.auth.login"})
		frappe.local.login_manager = LoginManager()

	def _profile(self, phone="+79990000078"):
		profile = frappe.get_doc(
			{
				"doctype": "Raspechatka User Profile",
				"last_name": "Тестов",
				"first_name": "Вход",
				"phone": phone,
				"active": 1,
				"access_profile": "Raspechatka Network Admin",
				"scope_type": "Network",
			}
		).insert(ignore_permissions=True)
		profile.reload()
		return profile

	def test_phone_normalization_contract(self):
		for value in (
			"89991234567",
			"79991234567",
			"+79991234567",
			"+7 999 123-45-67",
			"8 (999) 123-45-67",
		):
			self.assertEqual(auth.normalize_login_phone(value), "+79991234567")

	def test_admin_reset_then_five_login_logout_cycles_with_same_password(self):
		profile = self._profile()
		user = frappe.get_doc("User", profile.system_user)
		link = user._reset_password(send_email=False, password_expired=True)
		self.assertEqual(urlparse(link).path, "/update-password")
		key = parse_qs(urlparse(link).query)["key"][0]
		self.assertTrue(key)

		self._guest_request()
		update_password(new_password="Repeat-login-078!", key=key, logout_all_sessions=1)
		self.assertEqual(frappe.session.user, profile.system_user)
		self.assertFalse(frappe.db.get_value("User", profile.system_user, "reset_password_key"))
		frappe.local.login_manager.logout()
		reuse_result = update_password(
			new_password="Another-login-078!", key=key, logout_all_sessions=1
		)
		self.assertTrue(reuse_result)
		self.assertEqual(frappe.local.response.http_status_code, 410)

		for phone in (
			"89990000078",
			"79990000078",
			"+79990000078",
			"+7 999 000-00-78",
			"8 (999) 000-00-78",
		):
			self._guest_request()
			result = auth.login(phone, "Repeat-login-078!")
			self.assertEqual(result["redirect_to"], "/raspechatka")
			self.assertEqual(frappe.session.user, profile.system_user)
			frappe.local.login_manager.logout()
			self.assertEqual(frappe.session.user, "Guest")

		self.assertEqual(
			frappe.db.get_value("Raspechatka User Profile", profile.name, "invitation_status"),
			"Activated",
		)

	def test_wrong_phone_and_wrong_password_share_public_error(self):
		profile = self._profile("+79990000079")
		from frappe.utils.password import update_password as set_password

		set_password(profile.system_user, "Correct-password-079!")
		for phone, password in (
			("+79990000000", "Correct-password-079!"),
			("+79990000079", "Wrong-password-079!"),
		):
			self._guest_request()
			with self.assertRaises(frappe.AuthenticationError) as error:
				auth.login(phone, password)
			self.assertIn(auth.INVALID_CREDENTIALS, str(error.exception))

	def test_inactive_profile_cannot_login(self):
		profile = self._profile("+79990000080")
		frappe.db.set_value("Raspechatka User Profile", profile.name, "active", 0)
		self._guest_request()
		with self.assertRaises(frappe.AuthenticationError) as error:
			auth.login(profile.phone, "Any-password-080!")
		self.assertIn(auth.INACTIVE_ACCOUNT, str(error.exception))
