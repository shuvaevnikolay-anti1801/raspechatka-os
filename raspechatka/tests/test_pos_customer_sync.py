# ruff: noqa: RUF001
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka.api import pos_device, pos_v2


class Row(dict):
	__getattr__ = dict.get


class TestPosCustomerSync(TestCase):
	def test_network_snapshot_is_active_club_only_minimal_and_unlimited(self):
		get_all = Mock(
			return_value=[
				Row(name="CLIENT-1", client_name="Иван", phone="+79991234821", discount_percent=5)
			]
		)
		with patch.object(pos_device, "frappe", SimpleNamespace(get_all=get_all)):
			result = pos_device._customers()

		self.assertEqual(
			result,
			[{"id": "CLIENT-1", "name": "Иван", "phone": "+79991234821", "discountPercent": 5.0}],
		)
		kwargs = get_all.call_args.kwargs
		self.assertEqual(kwargs["filters"], {"active": 1, "club_status": "Активен"})
		self.assertEqual(kwargs["limit_page_length"], 0)
		self.assertEqual(set(result[0]), {"id", "name", "phone", "discountPercent"})

	def test_pos_v2_does_not_narrow_customers_by_connection_point(self):
		rows = [{"id": "CLIENT-OTHER-POINT"}]
		with patch.object(pos_v2.base_pos, "_customers", return_value=rows) as customers:
			self.assertIs(pos_v2._customers(), rows)
		customers.assert_called_once_with()

	def test_server_uses_current_customer_state_and_preserves_offline_fact(self):
		get_value = Mock(
			side_effect=[
				Row(active=1, club_status="Активен", discount_percent=5),
				0,
				Row(active=0, club_status="Заблокирован", discount_percent=0),
				0,
			]
		)
		fake = SimpleNamespace(db=SimpleNamespace(get_value=get_value), log_error=Mock())
		connection = SimpleNamespace(business_point="POINT-1")
		with (
			patch.object(pos_v2, "frappe", fake),
			patch.object(
				pos_v2,
				"get_pos_sales_rules",
				return_value={"allowDiscounts": True, "maxDiscountPercent": 10},
			),
		):
			current = pos_v2._review_breakdown(
				{"customerId": "CLIENT-1", "clubDiscountPercent": 5}, connection, 10000, 9500
			)
			offline = pos_v2._review_breakdown(
				{"customerId": "CLIENT-1", "clubDiscountPercent": 5}, connection, 10000, 9500
			)

		self.assertEqual(current, (0, 0, 0, 5.0))
		self.assertEqual(offline, (0, 0, 0, 5.0))
		fake.log_error.assert_called_once()

	def test_receipt_ingestion_persists_explicit_club_percent_for_history(self):
		root = Path(__file__).resolve().parents[2]
		pos_source = (root / "raspechatka/api/pos_v2.py").read_text(encoding="utf-8")
		sales_source = (root / "raspechatka/api/sales.py").read_text(encoding="utf-8")
		receipt_source = (
			root / "raspechatka/raspechatka_os/doctype/sales_receipt/sales_receipt.py"
		).read_text(encoding="utf-8")
		self.assertIn('"clubDiscountPercent": club_discount_percent', pos_source)
		self.assertIn('"source_payload_json"', sales_source)
		self.assertIn('payload.get("clubDiscountPercent", payload.get("receiptDiscountPercent"))', receipt_source)
