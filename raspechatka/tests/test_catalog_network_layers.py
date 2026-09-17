from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka import access
from raspechatka.api import catalog_layers


class TestCatalogLayerSecurity(TestCase):
	def test_foreign_point_is_rejected_before_data_access(self):
		permission_error = type("PermissionError", (Exception,), {})
		fake = SimpleNamespace(
			PermissionError=permission_error,
			db=SimpleNamespace(exists=Mock(return_value=True)),
			throw=Mock(side_effect=permission_error),
		)
		with (
			patch.object(catalog_layers, "frappe", fake),
			patch.object(catalog_layers, "get_scope", return_value={"global": False, "points": ["POINT-A"]}),
			self.assertRaises(permission_error),
		):
			catalog_layers._ensure_point("POINT-B")

	def test_warehouse_must_belong_to_selected_point(self):
		permission_error = type("PermissionError", (Exception,), {})
		fake = SimpleNamespace(
			PermissionError=permission_error,
			db=SimpleNamespace(exists=Mock(return_value=False)),
			throw=Mock(side_effect=permission_error),
		)
		with patch.object(catalog_layers, "frappe", fake), self.assertRaises(permission_error):
			catalog_layers._ensure_warehouse("POINT-A", "WAREHOUSE-B")

	def test_minimum_stock_rejects_service_and_bundle(self):
		for item_type in ("Service", "Bundle"):
			permission_error = type("PermissionError", (Exception,), {})
			fake = SimpleNamespace(
				PermissionError=permission_error,
				get_doc=Mock(return_value=SimpleNamespace(active=1, track_inventory=0, item_type=item_type)),
				throw=Mock(side_effect=permission_error),
			)
			with (
				patch.object(catalog_layers, "frappe", fake),
				patch.object(catalog_layers, "_require_layer"),
				patch.object(catalog_layers, "_ensure_point", return_value="POINT-A"),
				patch.object(catalog_layers, "_ensure_warehouse", return_value="WAREHOUSE-A"),
				self.assertRaises(permission_error),
			):
				catalog_layers.save_minimum_stock("POINT-A", "ITEM", "WAREHOUSE-A", 10, 20)

	def test_all_points_resolves_only_active_points_inside_scope(self):
		fake = SimpleNamespace(get_all=Mock(return_value=["POINT-A", "POINT-B"]))
		with (
			patch.object(catalog_layers, "frappe", fake),
			patch.object(
				catalog_layers,
				"get_scope",
				return_value={"global": False, "points": ["POINT-A", "POINT-B"]},
			),
		):
			points = catalog_layers._selected_points(catalog_layers.ALL_POINTS, allow_all=True)
		self.assertEqual(points, ["POINT-A", "POINT-B"])
		filters = fake.get_all.call_args.kwargs["filters"]
		self.assertEqual(filters["active"], 1)
		self.assertEqual(filters["name"], ["in", ["POINT-A", "POINT-B"]])

	def test_all_points_is_rejected_outside_assortment_context(self):
		permission_error = type("PermissionError", (Exception,), {})
		fake = SimpleNamespace(PermissionError=permission_error, throw=Mock(side_effect=permission_error))
		with patch.object(catalog_layers, "frappe", fake), self.assertRaises(permission_error):
			catalog_layers._selected_points(catalog_layers.ALL_POINTS, allow_all=False)


class TestCatalogLayerContracts(TestCase):
	def test_navigation_exposes_four_product_pages(self):
		root = Path(__file__).resolve().parents[2]
		manifest = (root / "frontend/src/access-pages.json").read_text(encoding="utf-8")
		for route in ("/catalog", "/catalog/assortment", "/catalog/prices", "/catalog/minimum-stock"):
			self.assertIn(f'"route": "{route}"', manifest)

	def test_pos_contract_uses_enabled_as_single_sale_flag(self):
		root = Path(__file__).resolve().parents[1]
		pos_source = (root / "api/pos.py").read_text(encoding="utf-8")
		self.assertIn('"enabled": 1', pos_source)
		self.assertNotIn('"visible_in_pos": 1', pos_source)
		self.assertIn("resolve_item_price", pos_source)

	def test_new_catalog_item_does_not_create_default_pos_assortment(self):
		root = Path(__file__).resolve().parents[1]
		source = (root / "api/frontend.py").read_text(encoding="utf-8")
		save_source = source.split("def save_catalog_item", 1)[1].split("def _archive_values", 1)[0]
		self.assertNotIn("_create_default_assortments", save_source)

	def test_assortment_page_has_all_points_and_no_search(self):
		root = Path(__file__).resolve().parents[2]
		source = (root / "frontend/src/pages/CatalogPointLayerPage.vue").read_text(encoding="utf-8")
		self.assertIn('value="__all__">Все точки', source)
		self.assertIn("layer !== 'assortment'", source)
		self.assertNotIn("Видим в POS", source)

	def test_legacy_migration_preserves_effective_pos_visibility(self):
		root = Path(__file__).resolve().parents[1]
		source = (
			root / "patches/v1_0/canonicalize_pos_assortment_enabled.py"
		).read_text(encoding="utf-8")
		self.assertIn("enabled = 1 AND visible_in_pos = 1", source)
		self.assertIn("visible_in_pos = IF", source)

	def test_all_points_aggregation_uses_frappe_query_builder(self):
		root = Path(__file__).resolve().parents[1]
		source = (root / "api/catalog_layers.py").read_text(encoding="utf-8")
		all_points_source = source.split("def _assortment_rows_all", 1)[1].split(
			"def get_assortment_group_states", 1
		)[0]
		self.assertIn('Count(assortment.name).as_("enabled_count")', all_points_source)
		self.assertNotIn('"count(name) as enabled_count"', all_points_source)

	def test_reorder_reports_and_editor_share_canonical_rule(self):
		root = Path(__file__).resolve().parents[1]
		layer_source = (root / "api/catalog_layers.py").read_text(encoding="utf-8")
		report_source = (root / "api/warehouse_reports.py").read_text(encoding="utf-8")
		self.assertIn('"Catalog Reorder Rule"', layer_source)
		self.assertIn('"Catalog Reorder Rule"', report_source)

	def test_legacy_point_price_is_not_used_by_new_layer(self):
		root = Path(__file__).resolve().parents[1]
		layer_source = (root / "api/catalog_layers.py").read_text(encoding="utf-8")
		self.assertNotIn("local_sale_price", layer_source)



class TestAccessPageMigration(TestCase):
	def test_new_catalog_pages_copy_legacy_page_level_without_set_operations(self):
		legacy = SimpleNamespace(
			role="Manager", access_area="page.catalog", access_level="Edit"
		)
		rules = [legacy]
		doc = SimpleNamespace(rules=rules, save=Mock())

		def append(_field, values):
			rules.append(SimpleNamespace(**values))

		doc.append = append
		fake_frappe = SimpleNamespace(get_single=Mock(return_value=doc))
		pages = [{
			"area": "page.catalog.assortment",
			"legacy_area": "page.catalog",
		}]
		with (
			patch.object(access, "frappe", fake_frappe),
			patch.object(access, "get_matrix_roles", return_value=["Manager"]),
			patch.object(access, "_required_page_level", return_value=None),
		):
			access._sync_missing_page_rules(pages)

		self.assertEqual(rules[-1].access_area, "page.catalog.assortment")
		self.assertEqual(rules[-1].access_level, "Edit")
		doc.save.assert_called_once_with(ignore_permissions=True)
