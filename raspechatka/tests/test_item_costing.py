from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka import costing, stock


def row(**values):
	return SimpleNamespace(**values)


class CostingFrappe:
	ValidationError = ValueError

	def __init__(self, items, components=(), balances=(), warehouse="WAREHOUSE-A"):
		self.items = items
		self.components = list(components)
		self.balances = list(balances)
		self.warehouse = warehouse
		self.calls = []
		self.throw = Mock(side_effect=ValueError)

	def get_all(self, doctype, **kwargs):
		self.calls.append((doctype, kwargs))
		if doctype == "Catalog Warehouse":
			return [self.warehouse]
		if doctype == "Catalog Item":
			names = set(kwargs["filters"]["name"][1])
			return [item for item in self.items if item.name in names]
		if doctype == "Catalog Bundle Component":
			parents = set(kwargs["filters"]["parent"][1])
			return [component for component in self.components if component.parent in parents]
		if doctype == "Stock Balance":
			names = set(kwargs["filters"]["item"][1])
			return [balance for balance in self.balances if balance.item in names]
		raise AssertionError(doctype)


class TestPointItemCosts(TestCase):
	def resolve(self, items, components=(), balances=(), requested=None, warehouse="WAREHOUSE-A"):
		fake = CostingFrappe(items, components, balances, warehouse)
		rates = {}
		for balance in balances:
			if balance.actual_qty > 0:
				rate = balance.average_rate or balance.stock_value / balance.actual_qty
				rates[balance.item] = rate if rate > 0 else None
		with (
			patch.object(costing, "frappe", fake),
			patch.object(
				costing,
				"get_warehouse_average_rates",
				side_effect=lambda names, _wh: {name: rates.get(name) for name in names},
			),
		):
			result = costing.get_point_item_costs(requested or [item.name for item in items], "POINT-A")
		return result, fake

	def test_product_and_variant_use_their_own_stock_balance(self):
		items = [
			row(name="PRODUCT", item_name="Товар", item_type="Product"),
			row(name="VARIANT", item_name="Вариант", item_type="Variant"),
		]
		balances = [
			row(item="PRODUCT", actual_qty=2, stock_value=240, average_rate=120),
			row(item="VARIANT", actual_qty=4, stock_value=72, average_rate=18),
		]
		result, _fake = self.resolve(items, balances=balances)
		self.assertEqual(result["PRODUCT"]["cost"], 120)
		self.assertEqual(result["VARIANT"]["cost"], 18)
		self.assertEqual(result["VARIANT"]["source"], "stock_balance")

	def test_same_product_can_have_different_point_costs(self):
		item = row(name="PRODUCT", item_name="Товар", item_type="Product")
		first, _fake = self.resolve(
			[item], [], [row(item="PRODUCT", actual_qty=1, stock_value=120, average_rate=120)]
		)
		second, _fake = self.resolve(
			[item],
			[],
			[row(item="PRODUCT", actual_qty=1, stock_value=180, average_rate=180)],
			warehouse="WAREHOUSE-B",
		)
		self.assertEqual(first["PRODUCT"]["cost"], 120)
		self.assertEqual(second["PRODUCT"]["cost"], 180)

	def test_service_is_known_zero_without_stock_balance(self):
		result, fake = self.resolve([row(name="SERVICE", item_name="Услуга", item_type="Service")])
		self.assertEqual(result["SERVICE"]["cost"], 0)
		self.assertEqual(result["SERVICE"]["status"], "available")
		self.assertEqual(result["SERVICE"]["source"], "service")
		self.assertNotIn("Stock Balance", [doctype for doctype, _kwargs in fake.calls])

	def test_bundle_sums_quantities_products_variant_and_service(self):
		items = [
			row(name="BUNDLE", item_name="Комплект", item_type="Bundle"),
			row(name="A", item_name="Первый товар", item_type="Product"),
			row(name="B", item_name="Вариант Б", item_type="Variant"),
			row(name="S", item_name="Услуга", item_type="Service"),
		]
		components = [
			row(parent="BUNDLE", item="A", quantity=2, idx=1),
			row(parent="BUNDLE", item="B", quantity=1, idx=2),
			row(parent="BUNDLE", item="S", quantity=4, idx=3),
		]
		balances = [
			row(item="A", actual_qty=10, stock_value=1200, average_rate=120),
			row(item="B", actual_qty=10, stock_value=180, average_rate=18),
		]
		result, _fake = self.resolve(items, components, balances, ["BUNDLE"])
		self.assertEqual(result["BUNDLE"]["cost"], 258)
		self.assertEqual(result["BUNDLE"]["source"], "bundle_components")

	def test_bundle_cost_changes_with_current_component_balance(self):
		items = [
			row(name="BUNDLE", item_name="Комплект", item_type="Bundle"),
			row(name="A", item_name="Товар", item_type="Product"),
		]
		components = [row(parent="BUNDLE", item="A", quantity=2, idx=1)]
		first, _fake = self.resolve(
			items,
			components,
			[row(item="A", actual_qty=10, stock_value=1000, average_rate=100)],
			["BUNDLE"],
		)
		second, _fake = self.resolve(
			items,
			components,
			[row(item="A", actual_qty=10, stock_value=1500, average_rate=150)],
			["BUNDLE"],
		)
		self.assertEqual(first["BUNDLE"]["cost"], 200)
		self.assertEqual(second["BUNDLE"]["cost"], 300)

	def test_unknown_physical_component_makes_bundle_incomplete(self):
		items = [
			row(name="BUNDLE", item_name="Комплект", item_type="Bundle"),
			row(name="A", item_name="Первый товар", item_type="Product"),
		]
		components = [row(parent="BUNDLE", item="A", quantity=1, idx=1)]
		result, _fake = self.resolve(items, components, requested=["BUNDLE"])
		self.assertIsNone(result["BUNDLE"]["cost"])
		self.assertEqual(result["BUNDLE"]["reason"], "bundle_incomplete")
		self.assertEqual(result["BUNDLE"]["component"], "A")

	def test_legacy_nested_bundle_fails_without_recursion(self):
		items = [
			row(name="OUTER", item_name="Внешний", item_type="Bundle"),
			row(name="INNER", item_name="Внутренний", item_type="Bundle"),
		]
		components = [row(parent="OUTER", item="INNER", quantity=1, idx=1)]
		result, fake = self.resolve(items, components, requested=["OUTER"])
		self.assertIsNone(result["OUTER"]["cost"])
		self.assertEqual(result["OUTER"]["component_reason"], "nested_bundle")
		self.assertEqual(
			len([doctype for doctype, _kwargs in fake.calls if doctype == "Catalog Bundle Component"]),
			1,
		)

	def test_batch_queries_are_constant_for_many_bundles(self):
		items = [row(name="A", item_name="Товар", item_type="Product")]
		components = []
		for index in range(50):
			name = f"BUNDLE-{index}"
			items.append(row(name=name, item_name=name, item_type="Bundle"))
			components.append(row(parent=name, item="A", quantity=1, idx=1))
		result, fake = self.resolve(
			items,
			components,
			[row(item="A", actual_qty=1, stock_value=10, average_rate=10)],
			[item.name for item in items if item.item_type == "Bundle"],
		)
		self.assertEqual(len(result), 50)
		self.assertLessEqual(len(fake.calls), 5)


class TestWarehouseAverageRates(TestCase):
	def test_batch_uses_average_rate_then_stock_value_fallback(self):
		fake = SimpleNamespace(
			get_all=Mock(
				return_value=[
					row(item="A", actual_qty=2, stock_value=240, average_rate=120),
					row(item="B", actual_qty=4, stock_value=72, average_rate=0),
					row(item="ZERO", actual_qty=0, stock_value=0, average_rate=0),
				]
			)
		)
		with patch.object(stock, "frappe", fake):
			result = stock.get_warehouse_average_rates(["A", "B", "ZERO", "MISSING"], "WH")
		self.assertEqual(result, {"A": 120, "B": 18, "ZERO": None, "MISSING": None})
		fake.get_all.assert_called_once()
