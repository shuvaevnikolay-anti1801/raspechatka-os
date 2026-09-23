from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka.api import pos, pos_v2


class TestPosOrders(TestCase):
	def test_order_update_is_point_scoped_and_keeps_first_ready_time(self):
		get_value = Mock(return_value="POS-ORDER-1")
		doc = SimpleNamespace(
			phone="+79000000000",
			contact_method="Telegram",
			comment="Старое описание",
			due_at="2026-09-20 10:00:00",
			ready_at="2026-09-20 09:30:00",
			issued_at=None,
			source_receipt=None,
			source_sale_id=None,
			status="In Progress",
			save=Mock(),
		)
		fake_frappe = SimpleNamespace(
			db=SimpleNamespace(get_value=get_value),
			get_doc=Mock(return_value=doc),
		)
		with (
			patch.object(pos, "_doctype_exists", return_value=True),
			patch.object(pos, "frappe", fake_frappe),
		):
			pos._apply_order_updated(
				"EVENT-1",
				SimpleNamespace(business_point="POINT-1"),
				{
					"orderNumber": "ORD-1",
					"phone": "+79001234567",
					"contactMethod": "WhatsApp",
					"comment": "Новое описание",
					"dueAt": "2026-09-20T12:00:00.000Z",
					"readyAt": "2026-09-20T10:30:00.000Z",
					"status": "ready",
				},
			)

		get_value.assert_called_once_with(
			"POS Order",
			{"order_number": "ORD-1", "business_point": "POINT-1"},
			"name",
		)
		self.assertEqual(doc.phone, "+79001234567")
		self.assertEqual(doc.contact_method, "WhatsApp")
		self.assertEqual(doc.comment, "Новое описание")
		self.assertEqual(doc.due_at, "2026-09-20T12:00:00.000Z")
		self.assertEqual(doc.ready_at, "2026-09-20 09:30:00")
		self.assertEqual(doc.status, "Ready")
		doc.save.assert_called_once_with(ignore_permissions=True)

	def test_order_update_ready_to_issued_and_replay_keep_first_issued_time(self):
		get_value = Mock(return_value="POS-ORDER-1")
		doc = SimpleNamespace(
			phone="+79000000000",
			contact_method="Telegram",
			comment="Описание",
			due_at="2026-09-20 12:00:00",
			ready_at="2026-09-20 10:30:00",
			issued_at=None,
			source_receipt="SALE-RECEIPT-1",
			source_sale_id="SALE-1",
			status="Ready",
			save=Mock(),
		)
		fake_frappe = SimpleNamespace(
			db=SimpleNamespace(get_value=get_value),
			get_doc=Mock(return_value=doc),
		)
		with (
			patch.object(pos, "_doctype_exists", return_value=True),
			patch.object(pos, "frappe", fake_frappe),
		):
			pos._apply_order_updated(
				"EVENT-ISSUED",
				SimpleNamespace(business_point="POINT-1"),
				{
					"orderNumber": "ORD-1",
					"status": "issued",
					"issuedAt": "2026-09-20T11:00:00.000Z",
				},
			)
			self.assertEqual(doc.issued_at, "2026-09-20T11:00:00.000Z")
			self.assertEqual(doc.status, "Issued")

			pos._apply_order_updated(
				"EVENT-ISSUED-REPLAY",
				SimpleNamespace(business_point="POINT-1"),
				{
					"orderNumber": "ORD-1",
					"status": "issued",
					"issuedAt": "2026-09-20T11:30:00.000Z",
				},
			)

		self.assertEqual(doc.issued_at, "2026-09-20T11:00:00.000Z")
		self.assertEqual(doc.status, "Issued")
		self.assertEqual(doc.source_receipt, "SALE-RECEIPT-1")
		self.assertEqual(doc.source_sale_id, "SALE-1")
		self.assertEqual(doc.save.call_count, 2)

	def test_timestamped_update_locks_order_and_ignores_duplicate_or_stale_replay(self):
		get_value = Mock(return_value="POS-ORDER-1")
		doc = SimpleNamespace(
			last_pos_update_at=None,
			last_pos_update_event=None,
			phone="old",
			contact_method=None,
			comment=None,
			due_at=None,
			ready_at=None,
			issued_at=None,
			source_receipt=None,
			source_sale_id=None,
			status="New",
			save=Mock(),
		)
		db = SimpleNamespace(get_value=get_value, sql=Mock(return_value=[("POS-ORDER-1",)]))
		with (
			patch.object(pos, "_doctype_exists", return_value=True),
			patch.object(pos, "frappe", SimpleNamespace(db=db, get_doc=Mock(return_value=doc))),
		):
			workplace = SimpleNamespace(business_point="POINT-1")
			new = {
				"orderNumber": "ORD-1",
				"updatedAt": "2026-09-20 12:00:00",
				"phone": "new",
				"status": "ready",
			}
			pos._apply_order_updated("EVENT-NEW", workplace, new)
			pos._apply_order_updated("EVENT-NEW", workplace, new)
			pos._apply_order_updated(
				"EVENT-OLD",
				workplace,
				{**new, "updatedAt": "2026-09-20 11:00:00", "phone": "old", "status": "new"},
			)
		self.assertEqual(doc.phone, "new")
		self.assertEqual(doc.status, "Ready")
		self.assertEqual(doc.last_pos_update_event, "EVENT-NEW")
		doc.save.assert_called_once_with(ignore_permissions=True)
		self.assertEqual(db.sql.call_count, 3)

	def test_order_create_rejects_when_canonical_doctype_is_unavailable(self):
		def throw(message, exception=None):
			raise (exception or RuntimeError)(message)

		with (
			patch.object(pos, "_doctype_exists", return_value=False),
			patch.object(pos, "frappe", SimpleNamespace(throw=throw)),
		):
			with self.assertRaisesRegex(RuntimeError, "POS Order"):
				pos._apply_order_created(
					"EVENT-CREATE",
					SimpleNamespace(business_point="POINT-1"),
					{"orderNumber": "ORD-1", "phone": "+79001234567", "lines": []},
				)

	def test_missing_order_update_is_rejected_instead_of_silently_accepted(self):
		def throw(message, exception=None):
			raise (exception or RuntimeError)(message)

		fake_frappe = SimpleNamespace(
			db=SimpleNamespace(get_value=Mock(return_value=None)),
			throw=throw,
		)
		with (
			patch.object(pos, "_doctype_exists", return_value=True),
			patch.object(pos, "frappe", fake_frappe),
		):
			with self.assertRaisesRegex(RuntimeError, "ORD-MISSING"):
				pos._apply_order_updated(
					"EVENT-MISSING",
					SimpleNamespace(business_point="POINT-1"),
					{"orderNumber": "ORD-MISSING", "status": "ready"},
				)

	def test_server_receipt_reference_never_escapes_current_point(self):
		get_value = Mock(return_value="SALE-RECEIPT-1")
		fake_frappe = SimpleNamespace(db=SimpleNamespace(get_value=get_value))
		with patch.object(pos, "frappe", fake_frappe):
			result = pos._order_source_receipt("POINT-1", "server:SALE-RECEIPT-1")

		self.assertEqual(result, "SALE-RECEIPT-1")
		get_value.assert_called_once_with(
			"Sales Receipt",
			{"name": "SALE-RECEIPT-1", "business_point": "POINT-1", "receipt_type": "Sale"},
			"name",
		)

	def test_duplicate_order_create_event_is_idempotent(self):
		doc = SimpleNamespace(insert=Mock())
		get_value = Mock(side_effect=[None, "POINT-1"])
		fake_frappe = SimpleNamespace(
			db=SimpleNamespace(get_value=get_value),
			get_doc=Mock(return_value=doc),
		)
		payload = {
			"orderNumber": "ORD-DUPLICATE",
			"phone": "+79001234567",
			"contactMethod": "Telegram @client",
			"status": "new",
			"lines": [],
		}
		with (
			patch.object(pos, "_doctype_exists", return_value=True),
			patch.object(pos, "frappe", fake_frappe),
		):
			pos._apply_order_created("EVENT-DUPLICATE", SimpleNamespace(business_point="POINT-1"), payload)
			pos._apply_order_created("EVENT-DUPLICATE", SimpleNamespace(business_point="POINT-1"), payload)

		fake_frappe.get_doc.assert_called_once()
		created_doc = fake_frappe.get_doc.call_args.args[0]
		self.assertEqual(created_doc["contact_method"], "Telegram @client")
		doc.insert.assert_called_once_with(ignore_permissions=True)

	def test_delayed_order_event_accepts_cashier_from_current_point(self):
		fake_frappe = SimpleNamespace(db=SimpleNamespace(get_value=Mock(return_value=None)))
		with (
			patch.object(pos_v2, "frappe", fake_frappe),
			patch.object(pos_v2.base_pos, "frappe", fake_frappe),
		):
			selected = pos_v2._trusted_event_cashier(
				SimpleNamespace(business_point="POINT-1"),
				[{"id": "EMP-1", "name": "Кассир"}],
				"order.updated",
				{"cashierId": "EMP-1"},
			)

		self.assertEqual(selected, {"id": "EMP-1", "name": "Кассир"})

	def test_delayed_order_event_rejects_foreign_cashier(self):
		def throw(message, exception=None):
			raise (exception or RuntimeError)(message)

		fake_frappe = SimpleNamespace(
			db=SimpleNamespace(get_value=Mock(return_value=None)),
			throw=throw,
			PermissionError=PermissionError,
		)
		with (
			patch.object(pos_v2, "frappe", fake_frappe),
			patch.object(pos_v2.base_pos, "frappe", fake_frappe),
		):
			with self.assertRaises(PermissionError):
				pos_v2._trusted_event_cashier(
					SimpleNamespace(business_point="POINT-1"),
					[{"id": "EMP-1", "name": "Кассир"}],
					"order.created",
					{"cashierId": "EMP-FOREIGN"},
				)
