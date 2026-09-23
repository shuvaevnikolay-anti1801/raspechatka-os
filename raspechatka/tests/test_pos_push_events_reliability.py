# ruff: noqa: RUF001
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from raspechatka.api import pos_v2


class TestPosPushEventsReliability(TestCase):
	def _connection(self):
		return SimpleNamespace(business_point="POINT-A", app_version=None, last_sync_at=None)

	def test_failed_first_event_rolls_back_without_blocking_second(self):
		connection = self._connection()
		durable = []
		checkpoints = {}

		def savepoint(name):
			checkpoints[name] = list(durable)

		def rollback(*, save_point=None):
			durable[:] = checkpoints[save_point]

		def ingest(event_id, payload, connection, cashier_id):
			durable.append(event_id)
			if event_id == "EVENT-BAD":
				raise pos_v2.frappe.ValidationError("Документ отклонён")

		events = [
			{
				"id": "EVENT-BAD",
				"eventType": "stock.write_off.requested",
				"payload": {"cashierId": "EMP-1", "productId": "ITEM-1", "quantity": 1},
			},
			{
				"id": "EVENT-GOOD",
				"eventType": "stock.write_off.requested",
				"payload": {"cashierId": "EMP-1", "productId": "ITEM-2", "quantity": 1},
			},
		]

		with (
			patch.object(pos_v2.base_pos, "_authenticate", return_value=connection),
			patch.object(pos_v2.base_pos, "_point_employees", return_value=[{"id": "EMP-1", "name": "Иван"}]),
			patch.object(pos_v2, "_trusted_event_cashier", return_value={"id": "EMP-1"}),
			patch.object(pos_v2.frappe.db, "savepoint", side_effect=savepoint) as savepoint_mock,
			patch.object(pos_v2.frappe.db, "rollback", side_effect=rollback) as rollback_mock,
			patch.object(pos_v2, "_ingest_stock_write_off", side_effect=ingest),
			patch.object(pos_v2.base_pos, "_touch"),
		):
			result = pos_v2.push_events("DEVICE-1", "TOKEN", events=events, app_version="test")

		self.assertEqual(result["accepted"], ["EVENT-GOOD"])
		self.assertEqual(
			result["errors"],
			[
				{
					"id": "EVENT-BAD",
					"eventType": "stock.write_off.requested",
					"message": "Документ отклонён",
				}
			],
		)
		self.assertEqual(durable, ["EVENT-GOOD"])
		self.assertEqual(savepoint_mock.call_count, 2)
		rollback_mock.assert_called_once_with(save_point="pos_event_0")

	def test_unsupported_event_is_rejected_and_not_accepted(self):
		connection = self._connection()
		with (
			patch.object(pos_v2.base_pos, "_authenticate", return_value=connection),
			patch.object(pos_v2.base_pos, "_point_employees", return_value=[{"id": "EMP-1", "name": "Иван"}]),
			patch.object(pos_v2.frappe.db, "savepoint"),
			patch.object(pos_v2.frappe.db, "rollback") as rollback_mock,
			patch.object(pos_v2, "_trusted_event_cashier") as trusted_cashier,
			patch.object(pos_v2.base_pos, "_touch"),
		):
			result = pos_v2.push_events(
				"DEVICE-1",
				"TOKEN",
				events=[{"id": "EVENT-UNKNOWN", "eventType": "future.event", "payload": {}}],
			)

		self.assertEqual(result["accepted"], [])
		self.assertEqual(result["errors"][0]["id"], "EVENT-UNKNOWN")
		self.assertEqual(result["errors"][0]["eventType"], "future.event")
		self.assertEqual(result["errors"][0]["message"], "Неподдерживаемый тип события: future.event")
		trusted_cashier.assert_not_called()
		rollback_mock.assert_called_once_with(save_point="pos_event_0")

	def test_explicit_permanent_validation_is_classified_and_later_event_proceeds(self):
		connection = self._connection()
		def ingest(event_id, payload, connection, cashier_id):
			if event_id == "INVALID":
				raise pos_v2.PermanentPosEventError("Недопустимая причина списания")
		with (
			patch.object(pos_v2.base_pos, "_authenticate", return_value=connection),
			patch.object(pos_v2.base_pos, "_point_employees", return_value=[]),
			patch.object(pos_v2, "_trusted_event_cashier", return_value={"id": "EMP-1"}),
			patch.object(pos_v2.frappe.db, "savepoint"),
			patch.object(pos_v2.frappe.db, "rollback"),
			patch.object(pos_v2, "_ingest_stock_write_off", side_effect=ingest),
			patch.object(pos_v2.base_pos, "_touch"),
		):
			result = pos_v2.push_events("DEVICE-1", "TOKEN", events=[
				{"id": "INVALID", "eventType": "stock.write_off.requested", "payload": {}},
				{"id": "VALID", "eventType": "stock.write_off.requested", "payload": {}},
			])
		self.assertEqual(result["accepted"], ["VALID"])
		self.assertEqual(result["errors"][0]["message"],
			"Invalid event: Недопустимая причина списания")

	def test_unexpected_event_error_does_not_expose_internal_details(self):
		connection = self._connection()
		with (
			patch.object(pos_v2.base_pos, "_authenticate", return_value=connection),
			patch.object(pos_v2.base_pos, "_point_employees", return_value=[{"id": "EMP-1", "name": "Иван"}]),
			patch.object(pos_v2, "_trusted_event_cashier", return_value={"id": "EMP-1"}),
			patch.object(pos_v2.frappe.db, "savepoint"),
			patch.object(pos_v2.frappe.db, "rollback"),
			patch.object(
				pos_v2,
				"_ingest_stock_write_off",
				side_effect=RuntimeError("token=TOP_SECRET\nTraceback: internal details"),
			),
			patch.object(pos_v2.base_pos, "_touch"),
		):
			result = pos_v2.push_events(
				"DEVICE-1",
				"TOKEN",
				events=[
					{
						"id": "EVENT-FAIL",
						"eventType": "stock.write_off.requested",
						"payload": {"cashierId": "EMP-1", "productId": "ITEM-1", "quantity": 1},
					}
				],
			)

		message = result["errors"][0]["message"]
		self.assertEqual(message, "Не удалось обработать событие")
		self.assertNotIn("TOP_SECRET", message)
		self.assertNotIn("Traceback", message)
