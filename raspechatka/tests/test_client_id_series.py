from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, call, patch

from raspechatka.raspechatka_os.doctype.client import client


class TestClientIdSeries(TestCase):
	def test_sync_advances_series_to_existing_max(self):
		db = SimpleNamespace(sql=Mock(side_effect=[[(250,)], []]))
		with patch.object(client, "frappe", SimpleNamespace(db=db)):
			result = client.sync_client_id_series(200)

		self.assertEqual(result, 250)
		self.assertEqual(db.sql.call_count, 2)
		self.assertEqual(db.sql.call_args_list[1].args[1], ("RP-", 250))

	def test_sync_respects_higher_explicit_id(self):
		db = SimpleNamespace(sql=Mock(side_effect=[[(250,)], []]))
		with patch.object(client, "frappe", SimpleNamespace(db=db)):
			result = client.sync_client_id_series(900)

		self.assertEqual(result, 900)
		self.assertEqual(db.sql.call_args_list[1].args[1], ("RP-", 900))

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
