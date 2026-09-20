from pathlib import Path
from unittest import TestCase


class TestMoySkladVariantRepairPatchContract(TestCase):
	def setUp(self):
		root = Path(__file__).resolve().parents[1]
		self.patch = (root / "patches/v1_0/repair_moysklad_variants.py").read_text(encoding="utf-8")
		self.patches = (root / "patches.txt").read_text(encoding="utf-8")

	def test_patch_is_registered_once(self):
		entry = "raspechatka.patches.v1_0.repair_moysklad_variants"
		self.assertEqual(self.patches.count(entry), 1)

	def test_all_candidates_are_preflighted_before_mutation(self):
		self.assertLess(
			self.patch.index("if failures:"),
			self.patch.index("for plan in plans:"),
		)
		self.assertIn("def _preflight_plan", self.patch)
		self.assertIn("def _apply_plan", self.patch)

	def test_candidate_requires_variant_meta_and_product_reference(self):
		self.assertIn('meta_type != "variant"', self.patch)
		self.assertIn('"/entity/variant/" not in href.casefold()', self.patch)
		self.assertIn('_source_reference_uuid(payload.get("product"), "product")', self.patch)
		self.assertIn("характеристики отсутствуют или пусты", self.patch)

	def test_conflicts_fail_closed_and_manual_variants_are_not_touched(self):
		self.assertIn('filters={"item_type": "Product"', self.patch)
		self.assertIn("обнаружен конфликтующий variant_of", self.patch)
		self.assertIn("конфликтующая canonical variant signature", self.patch)
		self.assertIn('if plan["existing_values"]:', self.patch)

	def test_cross_candidate_duplicate_signatures_fail_before_mutation(self):
		self.assertIn("def _validate_plan_set", self.patch)
		self.assertIn('key = (plan["parent"].name, plan["signature"])', self.patch)
		self.assertIn("имеют одинаковую variant signature", self.patch)
		self.assertLess(
			self.patch.index("_validate_plan_set(plans)"),
			self.patch.index("for plan in plans:"),
		)

	def test_repair_uses_same_variant_value_length_as_importer(self):
		self.assertIn('_normalize(row.get("name") or row.get("id"))[:140]', self.patch)
		self.assertIn('_normalize(_payload_value(row.get("value")))[:140]', self.patch)

	def test_repair_verifies_postconditions_before_success(self):
		self.assertIn("def _verify_plan", self.patch)
		self.assertIn("_verify_plan(plan)", self.patch)
		self.assertIn("DEV-157 postcondition failed", self.patch)
		self.assertIn("DEV-157: repaired", self.patch)

	def test_identity_and_external_links_are_preserved(self):
		apply_source = self.patch.split("def _apply_plan", 1)[1].split("def _variant_values", 1)[0]
		self.assertIn('frappe.db.set_value("Catalog Item", item.name, values', apply_source)
		self.assertIn('"catalog_group": parent.catalog_group', apply_source)
		self.assertIn('"stock_uom": parent.stock_uom', apply_source)
		self.assertIn("if not item.default_supplier and parent.default_supplier", apply_source)
		self.assertNotIn('"moysklad_id"', apply_source)
		self.assertNotIn('"moysklad_payload_json"', apply_source)
		self.assertNotIn("item.name =", apply_source)
		self.assertNotIn("frappe.delete_doc", apply_source)
		self.assertNotIn("requests.", self.patch)
