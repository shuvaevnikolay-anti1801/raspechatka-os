from pathlib import Path
from unittest import TestCase


class TestCatalogItemTypeContract(TestCase):
	def test_existing_item_type_is_immutable_before_other_validation(self):
		root = Path(__file__).resolve().parents[1]
		source = (root / "raspechatka_os/doctype/catalog_item/catalog_item.py").read_text(encoding="utf-8")
		validate_body = source.split("def validate(self):", 1)[1].split("def on_update", 1)[0]
		self.assertLess(validate_body.index("self._validate_immutable_type()"), validate_body.index("self._clean_identifiers()"))
		self.assertIn('frappe.db.get_value("Catalog Item", self.name, "item_type")', validate_body)
		self.assertIn("frappe.ValidationError", validate_body)

	def test_new_item_may_choose_its_type(self):
		root = Path(__file__).resolve().parents[1]
		source = (root / "raspechatka_os/doctype/catalog_item/catalog_item.py").read_text(encoding="utf-8")
		immutable_body = source.split("def _validate_immutable_type(self):", 1)[1].split("def on_update", 1)[0]
		self.assertIn("if self.is_new():\n\t\t\treturn", immutable_body)


class TestCatalogCardSourceContract(TestCase):
	def test_hidden_sales_rule_is_not_written_by_card_api(self):
		root = Path(__file__).resolve().parents[1]
		source = (root / "api/frontend.py").read_text(encoding="utf-8")
		allowed_block = source.split("allowed = (", 1)[1].split(")", 1)[0]
		self.assertNotIn("prevent_discounts", allowed_block)

	def test_tampered_update_type_is_rejected_by_api_before_assignment(self):
		root = Path(__file__).resolve().parents[1]
		source = (root / "api/frontend.py").read_text(encoding="utf-8")
		save_source = source.split("def save_catalog_item", 1)[1].split("def _archive_values", 1)[0]
		guard = save_source.index('data.get("item_type") != doc.item_type')
		assignment = save_source.index("for fieldname in allowed")
		self.assertLess(guard, assignment)
		self.assertIn("frappe.ValidationError", save_source[guard:assignment])

	def test_existing_hidden_tax_values_are_not_reset_on_card_save(self):
		root = Path(__file__).resolve().parents[1]
		source = (root / "raspechatka_os/doctype/catalog_item/catalog_item.py").read_text(encoding="utf-8")
		type_rules = source.split("def _apply_type_rules(self):", 1)[1].split("def _validate_group_and_unit", 1)[0]
		self.assertIn("if self.is_new():", type_rules)
		self.assertLess(type_rules.index("if self.is_new():"), type_rules.index('self.vat_rate = "Без НДС"'))

	def test_bundle_comment_is_hidden_but_preserved(self):
		root = Path(__file__).resolve().parents[2]
		page = (root / "frontend/src/pages/CatalogPage.vue").read_text(encoding="utf-8")
		self.assertNotIn('placeholder="Комментарий"', page)
		self.assertIn("row.notes ? { notes: row.notes }", page)

	def test_component_search_is_bounded_and_rejects_bundles(self):
		root = Path(__file__).resolve().parents[1]
		source = (root / "api/frontend.py").read_text(encoding="utf-8")
		search_source = source.split("def search_bundle_components", 1)[1].split("def save_catalog_item", 1)[0]
		self.assertIn('limit_page_length = min(max(cint(limit_page_length), 1), 50)', search_source)
		self.assertIn('["Product", "Service", "Variant"]', search_source)
		self.assertIn('f"%{value}%"', search_source)
