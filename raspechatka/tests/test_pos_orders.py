from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka.api import pos


class TestPosOrders(TestCase):
	def test_order_update_is_point_scoped_and_keeps_first_ready_time(self):
		get_value = Mock(return_value="POS-ORDER-1")
		doc = SimpleNamespace(
			phone="+79000000000",
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
		self.assertEqual(doc.comment, "Новое описание")
		self.assertEqual(doc.due_at, "2026-09-20T12:00:00.000Z")
		self.assertEqual(doc.ready_at, "2026-09-20 09:30:00")
		self.assertEqual(doc.status, "Ready")
		doc.save.assert_called_once_with(ignore_permissions=True)

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
