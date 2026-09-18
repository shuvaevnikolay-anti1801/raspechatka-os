from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka.api import pos_device, pos_v2
from raspechatka.sales import resolve_shift_type


class Row(dict):
	__getattr__ = dict.get


class TestCanonicalSalesShift(TestCase):
	def test_pos_shift_sends_explicit_type_without_legacy_regular_value(self):
		row = pos_device._shift(
			{"id": "SHIFT-1", "openedAt": "2026-09-18T06:00:00Z", "shiftType": "Утро"},
			"EMP-1",
		)
		self.assertEqual(row["shift_type"], "Утро")
		self.assertNotEqual(row["shift_type"], "Regular")
		closed = pos_device._shift(
			{
				"id": "SHIFT-1",
				"openedAt": "2026-09-18T06:00:00Z",
				"closedAt": "2026-09-18T15:00:00Z",
				"summary": {"expectedCashMinor": 99900},
			},
			"EMP-1",
			True,
		)
		self.assertIsNone(closed["closing_cash"])

	def test_server_fallback_uses_first_shift_sequence_not_opening_hour(self):
		db = SimpleNamespace(get_value=Mock(return_value="Europe/Moscow"), exists=Mock(return_value=None))
		with patch("raspechatka.sales.frappe.db", db):
			self.assertEqual(resolve_shift_type("POINT-1", "2026-09-18T17:00:00+00:00"), "Утро")
		db.exists.return_value = "SHIFT-1"
		with patch("raspechatka.sales.frappe.db", db):
			self.assertEqual(resolve_shift_type("POINT-1", "2026-09-18T06:00:00+00:00"), "Вечер")

	def test_delayed_event_uses_cashier_stored_on_shift_after_allowlist_refresh(self):
		fake = SimpleNamespace(
			db=SimpleNamespace(get_value=Mock(return_value=Row(cashier="EMP-1", business_point="POINT-1")))
		)
		with patch.object(pos_v2, "frappe", fake):
			selected = pos_v2._trusted_event_cashier(
				SimpleNamespace(business_point="POINT-1"),
				[],
				"sale.completed",
				{"shiftId": "SHIFT-1", "cashierId": "EMP-1"},
			)
		self.assertEqual(selected, {"id": "EMP-1"})

	def test_explicit_review_count_zero_one_two_is_preserved(self):
		fake = SimpleNamespace(db=SimpleNamespace(get_value=Mock(return_value=None)), log_error=Mock())
		with (
			patch.object(pos_v2, "frappe", fake),
			patch.object(
				pos_v2,
				"get_pos_sales_rules",
				return_value={
					"allowDiscounts": True,
					"maxDiscountPercent": 100,
					"reviewDiscountPerReviewMinor": 500,
				},
			),
		):
			for count in (0, 1, 2):
				result = pos_v2._review_breakdown(
					{"reviewCount": count, "reviewDiscountMinor": count * 500, "manualDiscountMinor": 0},
					SimpleNamespace(business_point="POINT-1"),
					10000,
					10000 - count * 500,
				)
				self.assertEqual(result[0], count)
				self.assertEqual(result[2], count * 500)

	def test_shift_totals_and_ui_contract_expose_canonical_facts(self):
		root = Path(__file__).resolve().parents[2]
		totals = (root / "raspechatka/sales.py").read_text(encoding="utf-8")
		ingest = (root / "raspechatka/api/sales.py").read_text(encoding="utf-8")
		page = (root / "frontend/src/pages/SalesPage.vue").read_text(encoding="utf-8")
		for source in ("Sales Receipt", "Sales Receipt Payment", "Cash Movement", "Cashier Action"):
			self.assertIn(source, totals)
		for field in (
			'"club_discount_amount"',
			'"review_count"',
			'"review_discount_amount"',
			'"manual_discount_amount"',
		):
			self.assertIn(field, ingest)
		for label in (
			"Продажи до скидок",
			"Продажи после скидок",
			"Движение наличных",
			"Действия кассира",
		):
			self.assertIn(label, page)
