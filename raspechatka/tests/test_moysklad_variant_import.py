from pathlib import Path
from unittest import TestCase


class TestMoySkladVariantImportContract(TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1]
        self.source = (root / "api/moysklad.py").read_text(encoding="utf-8")

    def test_entity_variants_are_upserted_as_variants(self):
        variant_loop = self.source.split("for row in variants:", 1)[1].split(
            "for row in bundles:", 1
        )[0]
        self.assertIn('"Variant"', variant_loop)
        self.assertNotIn('"Product"', variant_loop)
        self.assertIn("variant_of=item_map.get(parent_id)", variant_loop)

    def test_characteristics_are_canonical_variant_values_before_save(self):
        upsert = self.source.split("def _upsert_item(", 1)[1].split(
            "def _load_bundle_details", 1
        )[0]
        values_block = upsert.split('if item_type == "Variant":', 1)[1]
        self.assertIn('doc.set("variant_values", [])', values_block)
        self.assertIn("row.get(\"characteristics\")", values_block)
        self.assertIn('"attribute_name": attribute_name[:140]', values_block)
        self.assertIn('"attribute_value": attribute_value[:140]', values_block)
        self.assertLess(values_block.index('doc.set("variant_values", [])'), values_block.index("doc.save("))

    def test_variant_values_do_not_come_from_item_name(self):
        upsert = self.source.split("def _upsert_item(", 1)[1].split(
            "def _load_bundle_details", 1
        )[0]
        values_block = upsert.split('if item_type == "Variant":', 1)[1].split(
            'if item_type == "Bundle":', 1
        )[0]
        self.assertNotIn("doc.item_name", values_block)
        self.assertIn("_normalize_variant_text", values_block)
