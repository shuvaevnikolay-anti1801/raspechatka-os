from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka.api import clients
from raspechatka.raspechatka_os.doctype.client.client import calculate_loyalty_state


class Row(dict):
	__getattr__ = dict.get


def settings(*, active=1, maximum=10, required=True, limit=2, rules=None):
	return SimpleNamespace(
		active=active,
		maximum_discount_percent=maximum,
		max_active_channels=limit,
		personal_data_required=required,
		marketing_required=required,
		club_rules_required=required,
		discount_rules=rules
		or [
			SimpleNamespace(active=1, active_channel_count=0, discount_percent=0),
			SimpleNamespace(active=1, active_channel_count=1, discount_percent=4),
			SimpleNamespace(active=1, active_channel_count=2, discount_percent=7),
		],
	)


def client(**values):
	data = Row(
		active=1,
		personal_data_consent=1,
		marketing_consent=1,
		club_rules_consent=1,
	)
	data.update(values)
	return data


def messenger(kind, status="Активен", idx=1):
	return Row(messenger_type=kind, status=status, idx=idx)


class TestLoyaltyState(TestCase):
	def test_active_client_uses_saved_rules_for_one_and_two_channels(self):
		one = calculate_loyalty_state(client(), [messenger("Telegram")], settings())
		two = calculate_loyalty_state(client(), [messenger("Telegram"), messenger("VK", idx=2)], settings())
		self.assertEqual((one["club_status"], one["discount_percent"]), ("Активен", 4.0))
		self.assertEqual((two["club_status"], two["discount_percent"]), ("Активен", 7.0))

	def test_non_active_status_always_has_zero_discount(self):
		waiting = calculate_loyalty_state(client(), [], settings())
		blocked = calculate_loyalty_state(client(active=0), [messenger("Telegram")], settings())
		missing_consent = calculate_loyalty_state(
			client(marketing_consent=0), [messenger("Telegram")], settings()
		)
		self.assertEqual((waiting["club_status"], waiting["discount_percent"]), ("Ожидает мессенджер", 0.0))
		self.assertEqual((blocked["club_status"], blocked["discount_percent"]), ("Заблокирован", 0.0))
		self.assertEqual(
			(missing_consent["club_status"], missing_consent["discount_percent"]), ("Регистрация", 0.0)
		)

	def test_disabled_program_and_maximum_discount_force_safe_value(self):
		disabled = calculate_loyalty_state(client(), [messenger("Telegram")], settings(active=0))
		capped = calculate_loyalty_state(client(), [messenger("Telegram")], settings(maximum=3))
		zero_cap = calculate_loyalty_state(client(), [messenger("Telegram")], settings(maximum=0))
		self.assertEqual(disabled["discount_percent"], 0.0)
		self.assertEqual(capped["discount_percent"], 3.0)
		self.assertEqual(zero_cap["discount_percent"], 0.0)


class TestBulkLoyaltyRecalculation(TestCase):
	def test_legacy_client_is_updated_only_through_derived_fields(self):
		legacy = client(
			name="LEGACY-1",
			club_status="Заблокирован",
			discount_percent=3,
			active_channels=0,
			primary_channel="",
			backup_channel="",
			telegram_active=0,
			max_active=0,
			vk_active=0,
		)
		regular = client(
			name="CLIENT-2",
			club_status="Активен",
			discount_percent=4,
			active_channels=1,
			primary_channel="Telegram",
			backup_channel="",
			telegram_active=1,
			max_active=0,
			vk_active=0,
		)
		db = SimpleNamespace(
			sql=Mock(side_effect=[[(1,)], [(1,)]]),
			set_value=Mock(),
		)
		fake_frappe = SimpleNamespace(
			db=db,
			get_single=Mock(return_value=settings()),
			get_all=Mock(
				side_effect=[
					[legacy, regular],
					[Row(parent="LEGACY-1", messenger_type="Telegram", status="Активен", idx=1)],
				]
			),
			log_error=Mock(),
			get_traceback=Mock(return_value="traceback"),
			throw=Mock(side_effect=AssertionError),
		)

		with patch.object(clients, "frappe", fake_frappe):
			result = clients.recalculate_all_discounts()

		self.assertEqual(result["total"], 2)
		self.assertEqual(result["processed"], 2)
		self.assertEqual(result["changed"], 1)
		self.assertEqual(result["unchanged"], 1)
		db.set_value.assert_called_once()
		args = db.set_value.call_args.args
		self.assertEqual(args[:2], ("Client", "LEGACY-1"))
		self.assertTrue(set(args[2]).issubset(set(clients.LOYALTY_DERIVED_FIELDS)))
		self.assertIn("discount_percent", args[2])
		self.assertNotIn("legacy_club_discount", args[2])

	def test_endpoint_declares_network_write_contract(self):
		self.assertEqual(
			clients.run_loyalty_discount_recalculation._raspechatka_access_contract,
			{
				"area": "page.clients.club",
				"action": "write",
				"scope": "network",
				"auth": "session",
			},
		)
