# ruff: noqa: RUF001
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka.api import warehouse_reports


class AttrDict(dict):
	__getattr__ = dict.__getitem__


class TestStockMovementsPagination(TestCase):
	def test_rows_and_total_share_filters_and_supported_count(self):
		ledger_rows = [
			AttrDict(item="ITEM-A", warehouse="WH-A"),
			AttrDict(item="ITEM-A", warehouse="WH-A"),
		]
		calls = []

		def get_all(doctype, **kwargs):
			calls.append((doctype, kwargs))
			if doctype == "Stock Ledger Entry" and kwargs.get("fields") == [{"COUNT": "*", "as": "total"}]:
				return [SimpleNamespace(total=3)]
			if doctype == "Stock Ledger Entry":
				return ledger_rows
			if doctype == "Catalog Warehouse":
				return [SimpleNamespace(name="WH-A", warehouse_name="Склад А", business_point="POINT-A")]
			raise AssertionError(doctype)

		fake_frappe = SimpleNamespace(get_all=Mock(side_effect=get_all))
		effective_filters = {"is_reversal": 0, "import_batch": ["is", "not set"]}
		metadata = SimpleNamespace(item_name="Товар А", item_code="A", article="ART-A", stock_uom="шт")
		with (
			patch.object(warehouse_reports, "frappe", fake_frappe),
			patch.object(warehouse_reports, "require_access"),
			patch.object(warehouse_reports, "_warehouses", return_value=["WH-A"]),
			patch.object(warehouse_reports, "_effective_ledger_or_filters", return_value=effective_filters),
			patch.object(warehouse_reports, "_item_metadata", return_value={"ITEM-A": metadata}),
		):
			result = warehouse_reports.get_stock_movements.__wrapped__(
				from_date="2026-09-01",
				to_date="2026-09-30",
				warehouse="WH-A",
				item="ITEM-A",
				limit_start=0,
				limit_page_length=2,
			)

		ledger_calls = [kwargs for doctype, kwargs in calls if doctype == "Stock Ledger Entry"]
		self.assertEqual(len(result["rows"]), 2)
		self.assertEqual(result["total"], 3)
		self.assertIsInstance(result["total"], int)
		self.assertEqual(ledger_calls[0]["filters"], ledger_calls[1]["filters"])
		self.assertEqual(ledger_calls[0]["or_filters"], ledger_calls[1]["or_filters"])
		self.assertEqual(ledger_calls[0]["filters"]["warehouse"], ["in", ["WH-A"]])
		self.assertEqual(ledger_calls[0]["filters"]["item"], "ITEM-A")
		self.assertEqual(ledger_calls[0]["or_filters"], effective_filters)
		self.assertEqual(ledger_calls[0]["limit_page_length"], 2)
		self.assertEqual(ledger_calls[1]["limit_page_length"], 1)

	def test_search_item_filter_is_shared_by_rows_and_total(self):
		calls = []

		def get_all(doctype, **kwargs):
			calls.append((doctype, kwargs))
			if doctype == "Catalog Item":
				return ["ITEM-A"]
			if doctype == "Stock Ledger Entry" and isinstance(kwargs.get("fields", [None])[0], dict):
				return [SimpleNamespace(total=0)]
			if doctype in ("Stock Ledger Entry", "Catalog Warehouse"):
				return []
			raise AssertionError(doctype)

		with (
			patch.object(warehouse_reports, "frappe", SimpleNamespace(get_all=Mock(side_effect=get_all))),
			patch.object(warehouse_reports, "require_access"),
			patch.object(warehouse_reports, "_warehouses", return_value=["WH-A"]),
			patch.object(warehouse_reports, "_effective_ledger_or_filters", return_value={"is_reversal": 0}),
			patch.object(warehouse_reports, "_item_metadata", return_value={}),
		):
			result = warehouse_reports.get_stock_movements.__wrapped__(
				from_date="2026-09-01", to_date="2026-09-30", search="Товар"
			)

		ledger_calls = [kwargs for doctype, kwargs in calls if doctype == "Stock Ledger Entry"]
		self.assertEqual(result["total"], 0)
		self.assertEqual(ledger_calls[0]["filters"], ledger_calls[1]["filters"])
		self.assertEqual(ledger_calls[0]["filters"]["item"], ["in", ["ITEM-A"]])
		self.assertEqual(ledger_calls[0]["or_filters"], ledger_calls[1]["or_filters"])
