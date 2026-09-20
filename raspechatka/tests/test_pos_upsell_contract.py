from pathlib import Path
from unittest import TestCase


class TestPosUpsellContract(TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1]
        self.helper = (root / "pos_upsell.py").read_text(encoding="utf-8")
        self.sales = (root / "api/sales.py").read_text(encoding="utf-8")
        self.rule = (
            root / "raspechatka_os/doctype/pos_upsell_rule/pos_upsell_rule.json"
        ).read_text(encoding="utf-8")
        self.candidate = (
            root
            / "raspechatka_os/doctype/pos_upsell_candidate/pos_upsell_candidate.json"
        ).read_text(encoding="utf-8")

    def test_doctypes_define_network_rule_and_ordered_child(self):
        self.assertIn('"trigger_item"', self.rule)
        self.assertIn('"unique": 1', self.rule)
        self.assertIn('"enabled"', self.rule)
        self.assertIn('"options": "POS Upsell Candidate"', self.rule)
        self.assertIn('"istable": 1', self.candidate)
        self.assertIn('"fieldname": "item"', self.candidate)
        self.assertIn('"fieldname": "cashier_phrase"', self.candidate)
        self.assertIn('"fieldtype": "Small Text"', self.candidate)

    def test_validation_rejects_duplicate_triggers_targets_and_self_target(self):
        self.assertIn("seen_triggers", self.helper)
        self.assertIn("seen_targets", self.helper)
        self.assertIn("if target == trigger:", self.helper)
        self.assertIn("if target in seen_targets:", self.helper)
        self.assertIn("if enabled and not candidates:", self.helper)

    def test_sellable_guard_rejects_parent_products_with_active_variants(self):
        self.assertIn('SELLABLE_ITEM_TYPES = {"Product", "Service", "Variant", "Bundle"}', self.helper)
        self.assertIn('row.item_type == "Product" and row.has_variants', self.helper)
        self.assertIn("if not row or not row.active", self.helper)
        self.assertIn("if row.item_type not in SELLABLE_ITEM_TYPES", self.helper)

    def test_config_returns_selector_identity_and_display_fields(self):
        self.assertIn('"name": row.name', self.helper)
        self.assertIn('"item_name": row.item_name', self.helper)
        self.assertIn('"item_type": row.item_type', self.helper)
        self.assertIn('"cashier_phrase": row.cashier_phrase or ""', self.helper)

    def test_snapshot_reconcile_validates_then_rolls_back(self):
        self.assertLess(self.helper.index("rules = _validate_snapshot(snapshot)"), self.helper.index("frappe.db.savepoint"))
        self.assertIn("frappe.db.rollback(save_point=savepoint)", self.helper)
        self.assertIn("frappe.delete_doc", self.helper)
        self.assertIn('doc.set("candidates", [])', self.helper)

    def test_api_has_network_contract_and_global_write_guard(self):
        read_endpoint = self.sales.split("def get_pos_upsell_config", 1)[1].split(
            "def save_pos_upsell_rules", 1
        )[0]
        write_endpoint = self.sales.split("def save_pos_upsell_rules", 1)[1].split(
            "def provision_connection", 1
        )[0]
        self.assertIn('@access_contract(area="page.sales.integration", action="read", scope="network")', self.sales)
        self.assertIn('@access_contract(area="page.sales.integration", action="write", scope="network")', self.sales)
        self.assertIn('require_access("page.sales.integration", "read")', read_endpoint)
        self.assertIn('require_access("page.sales.integration", "write")', write_endpoint)
        self.assertIn('if not get_scope()["global"]:', write_endpoint)
