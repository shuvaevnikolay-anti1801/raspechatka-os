from decimal import Decimal
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from raspechatka.api import catalog_pricing


class TestCatalogPriceCalculator(TestCase):
	def test_percent_change_and_markup_formula(self):
		price, reason = catalog_pricing.calculate_price(
			100,
			60,
			{
				"mode": "change",
				"base": "current",
				"operation": "add",
				"unit": "percent",
				"value": 10,
				"rounding_step": 0,
			},
		)
		self.assertIsNone(reason)
		self.assertEqual(price, Decimal("110"))
		price, _ = catalog_pricing.calculate_price(
			100, 60, {"mode": "markup", "value": 50, "rounding_step": 0}
		)
		self.assertEqual(price, Decimal("90.0"))

	def test_rounding_nearest_up_and_down(self):
		base = {
			"mode": "change",
			"base": "current",
			"operation": "add",
			"unit": "ruble",
			"value": 3,
			"rounding_step": 10,
		}
		self.assertEqual(
			catalog_pricing.calculate_price(101, 50, {**base, "rounding_mode": "nearest"})[0], Decimal("100")
		)
		self.assertEqual(
			catalog_pricing.calculate_price(101, 50, {**base, "rounding_mode": "up"})[0], Decimal("110")
		)
		self.assertEqual(
			catalog_pricing.calculate_price(101, 50, {**base, "rounding_mode": "down"})[0], Decimal("100")
		)

	def test_cost_and_current_bases_support_rubles_and_percent(self):
		price, _ = catalog_pricing.calculate_price(
			200,
			80,
			{
				"mode": "change",
				"base": "cost",
				"operation": "add",
				"unit": "ruble",
				"value": 30,
				"rounding_step": 0,
			},
		)
		self.assertEqual(price, Decimal("110"))
		price, _ = catalog_pricing.calculate_price(
			200,
			80,
			{
				"mode": "change",
				"base": "current",
				"operation": "subtract",
				"unit": "percent",
				"value": 10,
				"rounding_step": 0,
			},
		)
		self.assertEqual(price, Decimal("180"))

	def test_markup_without_cost_is_skipped(self):
		price, reason = catalog_pricing.calculate_price(
			100, None, {"mode": "markup", "value": 50, "rounding_step": 0}
		)
		self.assertIsNone(price)
		self.assertIn("себестоимости", reason)


class TestCatalogPricingContracts(TestCase):
	def test_copy_skips_missing_source_without_zeroing_target(self):
		item = type("Item", (), {"name": "ITEM", "item_name": "Позиция"})()
		with (
			patch.object(catalog_pricing, "_items", return_value=[item]),
			patch.object(
				catalog_pricing,
				"resolve_point_prices",
				side_effect=[{"ITEM": None}, {"ITEM": {"rate": 125}}],
			),
			patch.object(catalog_pricing, "get_point_average_rates", return_value={"ITEM": 50}),
		):
			rows, _payload = catalog_pricing._copy_preview("TARGET", "SOURCE")
		self.assertEqual(rows[0]["status"], "skipped")
		self.assertIsNone(rows[0]["new_rate"])
		self.assertEqual(rows[0]["current_rate"], 125)

	def test_bulk_endpoints_have_explicit_point_contracts(self):
		for method, action in (
			(catalog_pricing.preview_copy_prices, "read"),
			(catalog_pricing.apply_copy_prices, "write"),
			(catalog_pricing.preview_calculated_prices, "read"),
			(catalog_pricing.apply_calculated_prices, "write"),
		):
			self.assertEqual(
				method._raspechatka_access_contract,
				{"area": "page.catalog.prices", "action": action, "scope": "point", "auth": "session"},
			)

	def test_ui_requires_preview_and_read_only_cost(self):
		root = Path(__file__).resolve().parents[2]
		source = (root / "frontend/src/components/CatalogPriceWorkspace.vue").read_text(encoding="utf-8")
		self.assertIn("Предпросмотр", source)
		self.assertIn("preview_token", source)
		self.assertNotIn('v-model.number="row.cost"', source)
