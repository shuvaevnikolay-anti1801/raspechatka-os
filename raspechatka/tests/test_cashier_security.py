from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka import access, security
from raspechatka.www import raspechatka as web


class TestCashierSecurity(TestCase):
	def _frappe(
		self, user="cashier@example.test", roles=(), linked_employee="EMP-1", path="/raspechatka", cmd=""
	):
		permission_error = type("PermissionError", (Exception,), {})
		throw = Mock(side_effect=permission_error)
		return SimpleNamespace(
			session=SimpleNamespace(user=user),
			local=SimpleNamespace(
				request=SimpleNamespace(path=path),
				form_dict={"cmd": cmd} if cmd else {},
				flags=SimpleNamespace(),
			),
			db=SimpleNamespace(get_value=Mock(return_value=linked_employee)),
			get_roles=Mock(return_value=list(roles)),
			throw=throw,
			PermissionError=permission_error,
		)

	def test_active_employee_linked_cashier_is_pos_only(self):
		fake = self._frappe(roles=("Raspechatka Cashier",))
		with patch.object(security, "frappe", fake):
			self.assertTrue(security.is_cashier_pos_only(fake.session.user))
		fake.db.get_value.assert_called_once_with(
			"Raspechatka User Profile",
			{"system_user": fake.session.user, "active": 1, "access_profile": "Raspechatka Cashier"},
			"linked_employee",
		)

	def test_cashier_web_is_denied_but_actual_pos_endpoints_are_allowed(self):
		fake = self._frappe(roles=("Raspechatka Cashier",))
		with patch.object(security, "frappe", fake):
			with self.assertRaises(fake.PermissionError):
				security.enforce_cashier_pos_only()
		for method in (
			"raspechatka.api.pos_v2.get_bootstrap",
			"raspechatka.api.pos_v2.push_events",
			"raspechatka.api.receipt_search.search_receipts",
		):
			fake = self._frappe(roles=("Raspechatka Cashier",), path=f"/api/method/{method}")
			with patch.object(security, "frappe", fake):
				security.enforce_cashier_pos_only()
			fake.throw.assert_not_called()

	def test_privileged_roles_are_never_pos_only_even_with_cashier_role(self):
		for user, role in (
			("Administrator", "Raspechatka Cashier"),
			("manager@example.test", "System Manager"),
			("network@example.test", "Raspechatka Network Admin"),
		):
			fake = self._frappe(user=user, roles=(role, "Raspechatka Cashier"))
			with patch.object(security, "frappe", fake):
				self.assertFalse(security.is_cashier_pos_only(user))
			fake.db.get_value.assert_not_called()

	def test_stale_cashier_role_is_governed_by_profile(self):
		fake = self._frappe(roles=("Raspechatka Point Manager", "Raspechatka Cashier"), linked_employee=None)
		with patch.object(security, "frappe", fake):
			self.assertFalse(security.is_cashier_pos_only(fake.session.user))
		fake = self._frappe(roles=("Raspechatka Point Manager",), linked_employee="EMP-1")
		with patch.object(security, "frappe", fake):
			self.assertTrue(security.is_cashier_pos_only(fake.session.user))

	def test_inactive_or_unlinked_cashier_profile_is_not_pos_only(self):
		for linked_employee in (None, ""):
			fake = self._frappe(roles=("Raspechatka Cashier",), linked_employee=linked_employee)
			with patch.object(security, "frappe", fake):
				self.assertFalse(security.is_cashier_pos_only(fake.session.user))

	def test_guest_login_and_logout_are_not_blocked(self):
		guest = self._frappe(user="Guest")
		with patch.object(security, "frappe", guest):
			security.enforce_cashier_pos_only()
		for method in ("login", "logout"):
			fake = self._frappe(roles=("Raspechatka Cashier",), path=f"/api/method/{method}")
			with patch.object(security, "frappe", fake):
				security.enforce_cashier_pos_only()
			fake.throw.assert_not_called()

	def test_web_guard_uses_profile_based_helper(self):
		fake = self._frappe(roles=("System Manager", "Raspechatka Cashier"))
		with (
			patch.object(web, "frappe", fake),
			patch.object(web, "is_cashier_pos_only", return_value=False) as check,
			patch.object(web, "get_boot", return_value={"ok": True}),
		):
			self.assertEqual(web.get_context(), {"boot": {"ok": True}})
		check.assert_called_once_with(fake.session.user)

	def test_access_level_uses_profile_based_cashier_mode(self):
		with (
			patch.object(access.frappe, "get_roles", return_value=["Raspechatka Cashier"]),
			patch.object(access, "is_cashier_pos_only", return_value=True),
		):
			self.assertEqual(access.get_access_level("page.dashboard", "cashier@example.test"), "None")
