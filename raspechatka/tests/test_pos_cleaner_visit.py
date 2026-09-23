from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

import frappe

from raspechatka.api import pos_v2


class TestCleanerVisitIngest(TestCase):
	def setUp(self):
		self.connection = SimpleNamespace(business_point="POINT-A")
		self.payload = {"id": "visit-1", "visitDate": "2026-09-02", "recordedBy": "forged"}

	def test_point_local_date_and_trusted_cashier_are_persisted(self):
		point_row = SimpleNamespace(name="POINT-A", timezone="Europe/Moscow")
		doc = Mock()
		with patch.object(pos_v2.frappe.db, "sql", return_value=[point_row]) as sql, patch.object(
			pos_v2.frappe.db, "exists", return_value=False
		), patch.object(pos_v2.frappe.db, "get_value", side_effect=[None, "trusted-user", "Trusted cashier"]), patch.object(
			pos_v2.frappe, "get_doc", return_value=doc
		) as get_doc, patch.object(
			pos_v2, "get_effective_site_timezone", return_value="Europe/Moscow"
		):
			pos_v2._ingest_cleaner_visit(
				"visit-1", self.payload, self.connection, "EMP-A", "2026-09-01T22:30:00Z"
			)
			self.assertIn("for update", sql.call_args.args[0])
			self.assertEqual(sql.call_args.args[1], ("POINT-A",))
			inserted = get_doc.call_args.args[0]
			self.assertEqual(inserted["business_point"], "POINT-A")
			self.assertEqual(inserted["visit_date"], "2026-09-02")
			self.assertEqual(inserted["recorded_by"], "trusted-user")
			self.assertEqual(inserted["recorded_by_name"], "Trusted cashier")
			self.assertEqual(inserted["source_pos_event"], "visit-1")
			doc.insert.assert_called_once_with(ignore_permissions=True)

	def test_older_queued_event_uses_utc_claim_but_persists_point_local_date(self):
		legacy_payload = {"id": "old-visit", "visitDate": "2026-09-01"}
		with patch.object(pos_v2.frappe.db, "sql", return_value=[SimpleNamespace(timezone="Europe/Moscow")]), patch.object(
			pos_v2.frappe.db, "exists", return_value=False
		), patch.object(pos_v2.frappe.db, "get_value", return_value=None), patch.object(
			pos_v2.frappe, "get_doc", return_value=Mock()
		) as get_doc, patch.object(pos_v2, "get_effective_site_timezone", return_value="Europe/Moscow"):
			pos_v2._ingest_cleaner_visit(
				"old-outbox-id", legacy_payload, self.connection, "EMP-A", "2026-09-01T22:30:00Z"
			)
			self.assertEqual(get_doc.call_args.args[0]["visit_date"], "2026-09-02")
			self.assertEqual(get_doc.call_args.args[0]["source_pos_event"], "old-outbox-id")

	def test_replay_of_same_event_is_idempotent(self):
		with patch.object(pos_v2.frappe.db, "sql", return_value=[SimpleNamespace(timezone="Europe/Moscow")]), patch.object(
			pos_v2.frappe.db, "get_value", return_value="POINT-A"
		), patch.object(pos_v2.frappe, "get_doc") as get_doc:
			pos_v2._ingest_cleaner_visit(
				"visit-1", self.payload, self.connection, "EMP-A", "2026-09-01T22:30:00Z"
			)
			get_doc.assert_not_called()

	def test_replayed_event_from_another_point_is_denied(self):
		with patch.object(pos_v2.frappe.db, "sql", return_value=[SimpleNamespace(timezone="Europe/Moscow")]), patch.object(
			pos_v2.frappe.db, "get_value", return_value="POINT-B"
		), patch.object(pos_v2.frappe, "get_doc") as get_doc:
			with self.assertRaises(frappe.PermissionError):
				pos_v2._ingest_cleaner_visit(
					"visit-1", self.payload, self.connection, "EMP-A", "2026-09-01T22:30:00Z"
				)
			get_doc.assert_not_called()

	def test_second_event_for_same_date_and_mismatched_local_date_are_rejected(self):
		with patch.object(pos_v2.frappe.db, "sql", return_value=[SimpleNamespace(timezone="Europe/Moscow")]), patch.object(
			pos_v2.frappe.db, "exists", return_value=True
		), patch.object(pos_v2.frappe.db, "get_value", return_value=None), patch.object(
			pos_v2, "get_effective_site_timezone", return_value="Europe/Moscow"
		):
			with self.assertRaises(frappe.ValidationError):
				pos_v2._ingest_cleaner_visit(
					"visit-1", self.payload, self.connection, "EMP-A", "2026-09-01T22:30:00Z"
				)
		with patch.object(pos_v2.frappe.db, "sql", return_value=[SimpleNamespace(timezone="Europe/Moscow")]), patch.object(
			pos_v2.frappe.db, "exists", return_value=False
		), patch.object(pos_v2.frappe.db, "get_value", return_value=None), patch.object(
			pos_v2, "get_effective_site_timezone", return_value="Europe/Moscow"
		):
			with self.assertRaises(frappe.ValidationError):
				pos_v2._ingest_cleaner_visit(
					"visit-1", {**self.payload, "visitDate": "2026-09-01"},
					self.connection, "EMP-A", "2026-09-01T22:30:00Z"
				)


class TestCleanerVisitDispatch(TestCase):
	def test_replayed_outbox_event_is_dispatched_with_authenticated_cashier(self):
		connection = SimpleNamespace(business_point="POINT-A", app_version="")
		event = {
			"id": "visit-1", "eventType": "cleaner.visit.recorded",
			"payload": {"id": "visit-1", "visitDate": "2026-09-02", "cashierId": "EMP-A"},
			"createdAt": "2026-09-01T22:30:00Z",
		}
		with patch.object(pos_v2.base_pos, "_authenticate", return_value=connection), patch.object(
			pos_v2.base_pos, "_point_employees", return_value=[]
		), patch.object(pos_v2, "_trusted_event_cashier", return_value={"id": "EMP-A"}), patch.object(
			pos_v2, "_normalize_v2_payload", side_effect=lambda value: value
		), patch.object(pos_v2, "_ingest_cleaner_visit") as ingest, patch.object(
			pos_v2.base_pos, "_touch"
		), patch.object(pos_v2.frappe.db, "savepoint"):
			result = pos_v2.push_events("device", "token", events=[event, event])
			self.assertEqual(result, {"accepted": ["visit-1", "visit-1"], "errors": []})
			self.assertEqual(ingest.call_count, 2)
			ingest.assert_called_with(
				"visit-1", event["payload"], connection, "EMP-A", event["createdAt"]
			)
