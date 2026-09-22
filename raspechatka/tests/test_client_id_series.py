from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, call, patch

from raspechatka.raspechatka_os.doctype.client import client


class TestClientIdSeries(TestCase):
	def test_sync_advances_series_to_existing_max(self):
		db = SimpleNamespace(sql=Mock(return_value=[(250,)]))
		series = Mock()
		series.get_current_value.return_value = 200
		with (
			patch.object(client, "frappe", SimpleNamespace(db=db)),
			patch.object(client, "NamingSeries", return_value=series) as naming_series,
		):
			result = client.sync_client_id_series(200)

		self.assertEqual(result, 250)
		naming_series.assert_called_once_with("RP-.######")
		series.update_counter.assert_called_once_with(250)

	def test_sync_respects_higher_explicit_id(self):
		db = SimpleNamespace(sql=Mock(return_value=[(250,)]))
		series = Mock()
		series.get_current_value.return_value = 250
		with (
			patch.object(client, "frappe", SimpleNamespace(db=db)),
			patch.object(client, "NamingSeries", return_value=series),
		):
			result = client.sync_client_id_series(900)

		self.assertEqual(result, 900)
		series.update_counter.assert_called_once_with(900)

	def test_sync_never_moves_series_backwards(self):
		db = SimpleNamespace(sql=Mock(return_value=[(250,)]))
		series = Mock()
		series.get_current_value.return_value = 1200
		with (
			patch.object(client, "frappe", SimpleNamespace(db=db)),
			patch.object(client, "NamingSeries", return_value=series),
		):
			result = client.sync_client_id_series(900)

		self.assertEqual(result, 1200)
		series.update_counter.assert_not_called()

	def test_next_client_id_resyncs_after_collision(self):
		db = SimpleNamespace(exists=Mock(side_effect=[True, False]))
		with (
			patch.object(client, "frappe", SimpleNamespace(db=db)),
			patch.object(client, "make_autoname", side_effect=["RP-000250", "RP-000301"]),
			patch.object(client, "sync_client_id_series") as sync,
		):
			result = client.next_client_id()

		self.assertEqual(result, "RP-000301")
		self.assertEqual(sync.call_args_list, [call(), call(250)])

	def test_explicit_imported_id_advances_series_before_insert(self):
		doc = SimpleNamespace(
			client_id="RP-000900",
			registered_by=None,
			registered_at=None,
			registration_source=None,
		)
		fake_frappe = SimpleNamespace(session=SimpleNamespace(user="Guest"))
		with (
			patch.object(client, "frappe", fake_frappe),
			patch.object(client, "sync_client_id_series") as sync,
			patch.object(client, "now_datetime", return_value="2026-09-22 10:00:00"),
		):
			client.Client.before_insert(doc)

		sync.assert_called_once_with(900)
		self.assertEqual(doc.client_id, "RP-000900")
