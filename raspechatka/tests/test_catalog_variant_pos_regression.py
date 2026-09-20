from pathlib import Path
from unittest import TestCase


class TestCatalogVariantPosRegressionContract(TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1]
        self.frontend_api = (root / "api/frontend.py").read_text(encoding="utf-8")
        self.pos_api = (root / "api/pos.py").read_text(encoding="utf-8")
        self.catalog_page = (
            root.parents[1] / "frontend/src/pages/CatalogPage.vue"
        ).read_text(encoding="utf-8")
        self.repair_patch = (
            root / "patches/v1_0/repair_moysklad_variants.py"
        ).read_text(encoding="utf-8")

    def test_catalog_list_exposes_variant_parent_and_inherited_group(self):
        catalog_list = self.frontend_api.split(
            "def get_catalog_items", 1
        )[1].split("def get_catalog_filters", 1)[0]
        self.assertIn('"catalog_group"', catalog_list)
        self.assertIn('"variant_of"', catalog_list)
        self.assertIn('"catalog_group_label"', catalog_list)
        self.assertIn('"variant_of_label"', catalog_list)

    def test_parent_card_loads_linked_variants_without_new_model(self):
        item_api = self.frontend_api.split(
            "def get_catalog_item", 1
        )[1].split("def search_bundle_components", 1)[0]
        self.assertIn('filters={"variant_of": name}', item_api)
        self.assertIn('"variant_of"', item_api)
        self.assertIn("currentVariants", self.catalog_page)
        self.assertIn("item.variant_of === itemForm.name", self.catalog_page)

    def test_pos_excludes_variant_parent_but_keeps_assorted_variant(self):
        products = self.pos_api.split("def _get_products", 1)[1].split(
            "def _get_customers", 1
        )[0]
        self.assertIn("if not item or item.has_variants:", products)
        self.assertIn('filters={"name": ["in", [row.item for row in assortments]]', products)
        self.assertIn("resolve_point_price(", products)
        self.assertIn('"id": item.name', products)
        self.assertIn('"Variant": "product"', products)

    def test_repair_and_runtime_do_not_rename_items_for_variant_display(self):
        self.assertNotIn("item_name =", self.repair_patch)
        self.assertNotIn("variant_values", self.pos_api)
        self.assertIn("variant_values", self.catalog_page)
        script = self.catalog_page.split("<template>", 1)[0]
        self.assertNotIn("itemForm.item_name =", script)
        self.assertNotIn("itemForm.item_name +=", script)
