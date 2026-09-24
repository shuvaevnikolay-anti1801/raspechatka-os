"""Unit contract for the central deletion boundary (runs without a Frappe site)."""
import ast
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


MODULE = Path(__file__).resolve().parents[1] / "raspechatka" / "deletion.py"


class DeletionContractTests(unittest.TestCase):
    def setUp(self):
        self.saved = {name: sys.modules.get(name) for name in (
            "frappe", "frappe.utils", "raspechatka", "raspechatka.access",
            "raspechatka.access_contract", "raspechatka.scope",
        )}
        frappe = types.ModuleType("frappe")
        frappe.db = MagicMock()
        frappe.session = types.SimpleNamespace(user="admin")
        frappe.PermissionError = type("PermissionError", (Exception,), {})
        frappe.AuthenticationError = type("AuthenticationError", (Exception,), {})
        frappe.ValidationError = type("ValidationError", (Exception,), {})
        frappe.throw = lambda message, error=None: (_ for _ in ()).throw((error or Exception)(message))
        frappe.whitelist = lambda **kwargs: lambda fn: fn
        frappe.as_json = lambda value: str(value)
        frappe.get_doc = MagicMock()
        utils = types.ModuleType("frappe.utils")
        utils.now_datetime = lambda: "2026-09-24 12:00:00"
        frappe.utils = utils
        frappe._ = lambda value: value
        access = types.ModuleType("raspechatka.access")
        access.require_access = MagicMock()
        contract = types.ModuleType("raspechatka.access_contract")
        contract.access_contract = lambda **kwargs: lambda fn: fn
        scope = types.ModuleType("raspechatka.scope")
        scope.ensure_entity_allowed = MagicMock()
        scope.ensure_point_allowed = MagicMock()
        sys.modules.update({
            "frappe": frappe, "frappe.utils": utils,
            "raspechatka.access": access,
            "raspechatka.access_contract": contract, "raspechatka.scope": scope,
        })
        spec = importlib.util.spec_from_file_location("_deletion_under_test", MODULE)
        self.module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.module
        spec.loader.exec_module(self.module)
        self.frappe, self.access, self.scope = frappe, access, scope
        self.frappe.get_doc.side_effect = lambda *args: (
            types.SimpleNamespace(name=args[1], business_point="P1", business_entity="E1")
            if len(args) == 2 else MagicMock(insert=MagicMock())
        )

    def tearDown(self):
        sys.modules.pop("_deletion_under_test", None)
        for name, prior in self.saved.items():
            if prior is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prior

    def test_view_and_edit_are_denied_by_page_delete_permission(self):
        for level in ("View", "Edit"):
            self.access.require_access.side_effect = self.frappe.PermissionError(level)
            with self.assertRaises(self.frappe.PermissionError):
                self.module.get_delete_preview("sales_receipt", "R1")
            self.frappe.get_doc.assert_not_called()

    def test_admin_preview_and_execute_share_scope_resolver(self):
        self.assertFalse(self.module.get_delete_preview("sales_receipt", "R1")["can_delete"])
        result = self.module.delete_entity("sales_receipt", "R1")
        self.assertEqual(result["strategy"], "blocked")
        self.access.require_access.assert_called_with("page.sales.receipts", "delete")
        self.assertEqual(self.scope.ensure_point_allowed.call_count, 2)
        self.frappe.db.sql.assert_called_once()
        self.frappe.get_doc.return_value.insert.assert_not_called()

    def test_foreign_point_is_rejected_before_strategy_and_audit(self):
        self.scope.ensure_point_allowed.side_effect = self.frappe.PermissionError("foreign")
        with self.assertRaises(self.frappe.PermissionError):
            self.module.delete_entity("sales_receipt", "R1")
        self.frappe.db.rollback.assert_called_once()

    def test_unknown_entity_never_reaches_get_doc(self):
        with self.assertRaises(self.frappe.PermissionError):
            self.module.get_delete_preview("User", "Administrator")
        self.frappe.get_doc.assert_not_called()

    def test_failed_handler_rolls_back_and_retry_reexecutes(self):
        doc = types.SimpleNamespace(name="R1", business_point="P1", business_entity="E1")
        self.frappe.get_doc.side_effect = lambda *args: doc if len(args) == 2 else MagicMock()
        handler = MagicMock(side_effect=RuntimeError("failed"))
        old = self.module.REGISTRY["sales_receipt"]
        self.module.REGISTRY["sales_receipt"] = self.module.DeletionRule(old.doctype, old.area, old.scope, handler)
        try:
            with self.assertRaises(RuntimeError):
                self.module.delete_entity("sales_receipt", "R1")
            self.assertEqual(handler.call_count, 1)
            self.frappe.db.rollback.assert_called_once()
            self.frappe.db.commit.assert_called_once()
            handler.side_effect = None
            handler.return_value = {"strategy": "blocked", "can_delete": False, "affected": []}
            self.module.delete_entity("sales_receipt", "R1")
            self.assertEqual(handler.call_count, 2)
        finally:
            self.module.REGISTRY["sales_receipt"] = old

    def test_suppressed_external_event_is_detected_by_stable_key(self):
        self.frappe.db.exists.return_value = "stored"
        self.assertTrue(self.module.is_external_event_suppressed("POS", "receipt-1"))
        key = self.frappe.db.exists.call_args.args[1]
        self.frappe.db.exists.return_value = None
        self.module.suppress_external_event("POS", "receipt-1", "sales_receipt", "R1")
        self.assertEqual(self.frappe.get_doc.call_args.args[0]["key"], key)
        self.assertFalse(self.module.is_external_event_suppressed("unknown", "receipt-1"))


    def test_suppressed_pos_receipt_never_reaches_upsert(self):
        source = MODULE.parent / "api" / "sales.py"
        tree = ast.parse(source.read_text())
        fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_ingest_receipt")
        namespace = {
            "_required": lambda row, field: row[field],
            "is_external_event_suppressed": lambda source, external_id: source == "POS" and external_id == "R1",
            "frappe": self.frappe,
        }
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(source), "exec"), namespace)
        stats = {"duplicates": 0}
        namespace["_ingest_receipt"]({"external_id": "R1"}, object(), stats)
        self.assertEqual(stats["duplicates"], 1)
        self.frappe.db.get_value.assert_not_called()

    def test_suppressed_moysklad_receipt_never_reaches_upsert(self):
        source = MODULE.parent / "api" / "moysklad_sales.py"
        tree = ast.parse(source.read_text())
        fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_upsert_receipt")
        namespace = {
            "_required_id": lambda row: row["id"],
            "_external_id": lambda kind, id: f"moysklad:{kind}:{id}",
            "is_external_event_suppressed": lambda source, external_id: source == "MoySklad",
            "frappe": self.frappe,
        }
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(source), "exec"), namespace)
        stats = {"duplicates": 0}
        namespace["_upsert_receipt"]({"id": "R1"}, {"stats": stats})
        self.assertEqual(stats["duplicates"], 1)
        self.frappe.db.get_value.assert_not_called()


if __name__ == "__main__":
    unittest.main()
