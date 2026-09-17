from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka import access, pricing
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

	def test_point_warehouse_rejects_legacy_multiple_active_warehouses(self):
		validation_error = type("ValidationError", (Exception,), {})
		fake = SimpleNamespace(
			ValidationError=validation_error,
			get_all=Mock(return_value=["WAREHOUSE-A", "WAREHOUSE-B"]),
			throw=Mock(side_effect=validation_error),
		)
		with patch.object(catalog_layers, "frappe", fake), self.assertRaises(validation_error):
			catalog_layers._point_warehouse("POINT-A")

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
				patch.object(catalog_layers, "_point_warehouse", return_value="WAREHOUSE-A"),
				self.assertRaises(permission_error),
			):
				catalog_layers.save_minimum_stock("POINT-A", "ITEM", 10, 20)

	def test_point_price_rejects_item_outside_enabled_assortment(self):
		permission_error = type("PermissionError", (Exception,), {})
		fake = SimpleNamespace(
			PermissionError=permission_error,
			db=SimpleNamespace(exists=Mock(return_value=False)),
			throw=Mock(side_effect=permission_error),
		)
		with (
			patch.object(catalog_layers, "frappe", fake),
			patch.object(catalog_layers, "_require_layer"),
			patch.object(catalog_layers, "_ensure_point", return_value="POINT-A"),
			self.assertRaises(permission_error),
		):
			catalog_layers.save_point_price("POINT-A", "ITEM-B", 100)
		fake.db.exists.assert_called_once_with(
			"Catalog Assortment", {"business_point": "POINT-A", "item": "ITEM-B", "enabled": 1}
		)

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
	def test_stock_norm_formula_uses_effective_history_and_ceil(self):
		minimum, target, average = catalog_layers._calculate_stock_norm(
			17, 10, {"minimum_days": 30, "target_days": 90}
		)
		self.assertEqual((minimum, target), (51, 153))
		self.assertEqual(average, 1.7)
		self.assertEqual(
			catalog_layers._calculate_stock_norm(-2, 10, {"minimum_days": 30, "target_days": 90}),
			(None, None, 0),
		)

	def test_navigation_exposes_four_product_pages(self):
		root = Path(__file__).resolve().parents[2]
		manifest = (root / "frontend/src/access-pages.json").read_text(encoding="utf-8")
		for route in ("/catalog", "/catalog/assortment", "/catalog/prices", "/catalog/minimum-stock"):
			self.assertIn(f'"route": "{route}"', manifest)
		self.assertIn('"label": "Нормативы запасов"', manifest)

	def test_pos_contract_uses_enabled_as_single_sale_flag(self):
		root = Path(__file__).resolve().parents[1]
		pos_source = (root / "api/pos.py").read_text(encoding="utf-8")
		self.assertIn('"enabled": 1', pos_source)
		self.assertNotIn('"visible_in_pos": 1', pos_source)
		self.assertIn("resolve_point_price", pos_source)
		self.assertNotIn("resolve_item_price(", pos_source)

	def test_new_catalog_item_does_not_create_default_pos_assortment(self):
		root = Path(__file__).resolve().parents[1]
		source = (root / "api/frontend.py").read_text(encoding="utf-8")
		save_source = source.split("def save_catalog_item", 1)[1].split("def _archive_values", 1)[0]
		self.assertNotIn("_create_default_assortments", save_source)

	def test_layer_page_keeps_all_points_only_for_assortment_and_has_no_search(self):
		root = Path(__file__).resolve().parents[2]
		source = (root / "frontend/src/pages/CatalogPointLayerPage.vue").read_text(encoding="utf-8")
		self.assertIn('value="__all__"', source)
		self.assertIn("layer === 'assortment'", source)
		self.assertNotIn('placeholder="Название, код или артикул"', source)
		self.assertNotIn("filters.search", source)
		self.assertNotIn("Видим в POS", source)

	def test_price_rows_prefilter_enabled_assortment_and_use_exact_point_resolver(self):
		root = Path(__file__).resolve().parents[1]
		source = (root / "api/catalog_layers.py").read_text(encoding="utf-8")
		rows_source = source.split("def get_rows", 1)[1].split("def _assortment_rows", 1)[0]
		price_source = source.split("def _price_rows", 1)[1].split("def _minimum_rows", 1)[0]
		self.assertIn('filters={"business_point": point, "enabled": 1}', rows_source)
		self.assertIn('filters["name"] = ["in", assortment_items', rows_source)
		self.assertIn("resolve_point_prices", price_source)
		self.assertIn("get_point_average_rates", price_source)
		self.assertNotIn("resolve_item_price(", price_source)

	def test_price_workspace_has_no_legacy_source_column(self):
		root = Path(__file__).resolve().parents[2]
		source = (root / "frontend/src/components/CatalogPriceWorkspace.vue").read_text(encoding="utf-8")
		self.assertNotIn("Источник", source)
		self.assertIn("Закупочная цена", source)
		self.assertIn("Наценка", source)

	def test_write_endpoints_declare_page_and_point_contracts(self):
		self.assertEqual(
			catalog_layers.save_point_price._raspechatka_access_contract,
			{"area": "page.catalog.prices", "action": "write", "scope": "point", "auth": "session"},
		)
		self.assertEqual(
			catalog_layers.save_minimum_stock._raspechatka_access_contract,
			{
				"area": "page.catalog.minimum-stock",
				"action": "write",
				"scope": "point",
				"auth": "session",
			},
		)

	def test_legacy_migration_preserves_effective_pos_visibility(self):
		root = Path(__file__).resolve().parents[1]
		source = (root / "patches/v1_0/canonicalize_pos_assortment_enabled.py").read_text(encoding="utf-8")
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

	def test_bulk_assortment_uses_supported_frappe_batch_api(self):
		root = Path(__file__).resolve().parents[1]
		source = (root / "api/catalog_layers.py").read_text(encoding="utf-8")
		bulk_source = source.split("def _apply_assortment", 1)[1].split("def save_point_price", 1)[0]
		self.assertIn("frappe.db.bulk_insert(", bulk_source)
		self.assertIn("ignore_duplicates=True", bulk_source)
		self.assertIn("existing_pairs", bulk_source)
		self.assertIn("missing_pairs", bulk_source)
		self.assertNotIn("ON DUPLICATE KEY UPDATE", bulk_source)

	def test_reorder_reports_and_editor_share_canonical_rule(self):
		root = Path(__file__).resolve().parents[1]
		layer_source = (root / "api/catalog_layers.py").read_text(encoding="utf-8")
		report_source = (root / "api/warehouse_reports.py").read_text(encoding="utf-8")
		self.assertIn('"Catalog Reorder Rule"', layer_source)
		self.assertIn('"Catalog Reorder Rule"', report_source)
		self.assertIn("target_stock - available - expected_qty", report_source)
		self.assertIn("available <= minimum_stock", report_source)

	def test_stock_norms_ui_has_no_warehouse_selector_and_uses_target(self):
		root = Path(__file__).resolve().parents[2]
		source = (root / "frontend/src/components/StockNormsWorkspace.vue").read_text(encoding="utf-8")
		self.assertNotIn("warehouse", source.lower())
		self.assertIn("target_stock", source)
		self.assertIn("preview_stock_norms", source)
		self.assertIn("copy_stock_norms", source)

	def test_stock_norms_schema_keeps_legacy_quantity_and_adds_target(self):
		root = Path(__file__).resolve().parents[1]
		rule = (root / "raspechatka_os/doctype/catalog_reorder_rule/catalog_reorder_rule.json").read_text()
		item = (root / "raspechatka_os/doctype/catalog_item/catalog_item.json").read_text()
		self.assertIn('"fieldname":"target_stock"', rule)
		self.assertIn('"fieldname":"reorder_quantity"', rule)
		self.assertIn('"fieldname": "starting_minimum_stock"', item)

	def test_warehouse_policy_is_global_admin_page(self):
		root = Path(__file__).resolve().parents[2]
		manifest = (root / "frontend/src/access-pages.json").read_text()
		api = (root / "raspechatka/api/warehouse_settings.py").read_text()
		self.assertIn('"area": "page.warehouse.settings"', manifest)
		self.assertIn('"minimum": "Admin"', manifest)
		self.assertIn('action="admin", scope="network"', api)

	def test_legacy_point_price_is_not_used_by_new_layer(self):
		root = Path(__file__).resolve().parents[1]
		layer_source = (root / "api/catalog_layers.py").read_text(encoding="utf-8")
		self.assertNotIn("local_sale_price", layer_source)


class TestBatchPriceResolver(TestCase):
	def test_batch_resolver_preserves_point_priority_and_variant_inheritance(self):
		items = {
			"PRODUCT": SimpleNamespace(name="PRODUCT", stock_uom="шт", variant_of=None),
			"VARIANT": SimpleNamespace(name="VARIANT", stock_uom="шт", variant_of="PRODUCT"),
		}
		price_rows = [
			SimpleNamespace(
				parent="PRODUCT",
				rate=100,
				business_point=None,
				uom="шт",
				currency="RUB",
				minimum_quantity=1,
				valid_from=None,
				valid_upto=None,
				idx=1,
			),
			SimpleNamespace(
				parent="PRODUCT",
				rate=120,
				business_point="POINT-A",
				uom="шт",
				currency="RUB",
				minimum_quantity=1,
				valid_from=None,
				valid_upto=None,
				idx=2,
			),
		]

		def get_all(doctype, filters=None, **_kwargs):
			if doctype == "Catalog Item":
				return [items[name] for name in filters["name"][1] if name in items]
			if doctype == "Catalog Item Price":
				return price_rows
			raise AssertionError(doctype)

		fake = SimpleNamespace(
			db=SimpleNamespace(
				get_value=Mock(return_value=SimpleNamespace(active=1, price_rounding="Без округления"))
			),
			get_all=Mock(side_effect=get_all),
			throw=Mock(side_effect=AssertionError),
		)
		with (
			patch.object(pricing, "frappe", fake),
			patch.object(pricing, "nowdate", return_value="2026-09-17"),
		):
			result = pricing.resolve_item_prices(["PRODUCT", "VARIANT"], "POINT-A", price_type="RETAIL")

		self.assertEqual(result["PRODUCT"]["rate"], 120)
		self.assertEqual(result["PRODUCT"]["source"], "Point")
		self.assertEqual(result["VARIANT"]["rate"], 120)
		self.assertEqual(result["VARIANT"]["source"], "Variant Parent")
		self.assertEqual(result["VARIANT"]["inherited_from"], "PRODUCT")
		self.assertEqual(
			sum(call.args[0] == "Catalog Item Price" for call in fake.get_all.call_args_list),
			1,
		)


class TestAccessPageMigration(TestCase):
	def test_new_catalog_pages_copy_legacy_page_level_without_set_operations(self):
		legacy = SimpleNamespace(role="Manager", access_area="page.catalog", access_level="Edit")
		rules = [legacy]
		doc = SimpleNamespace(rules=rules, save=Mock())

		def append(_field, values):
			rules.append(SimpleNamespace(**values))

		doc.append = append
		fake_frappe = SimpleNamespace(get_single=Mock(return_value=doc))
		pages = [
			{
				"area": "page.catalog.assortment",
				"legacy_area": "page.catalog",
			}
		]
		with (
			patch.object(access, "frappe", fake_frappe),
			patch.object(access, "get_matrix_roles", return_value=["Manager"]),
			patch.object(access, "_required_page_level", return_value=None),
		):
			access._sync_missing_page_rules(pages)

		self.assertEqual(rules[-1].access_area, "page.catalog.assortment")
		self.assertEqual(rules[-1].access_level, "Edit")
		doc.save.assert_called_once_with(ignore_permissions=True)
