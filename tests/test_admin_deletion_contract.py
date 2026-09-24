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
        frappe.delete_doc = MagicMock()
        frappe.get_all = MagicMock(return_value=[])
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
        self.assertFalse(self.module.get_delete_preview("business_point", "R1")["can_delete"])
        result = self.module.delete_entity("business_point", "R1")
        self.assertEqual(result["strategy"], "blocked")
        self.access.require_access.assert_called_with("page.sales.overview", "delete")
        self.assertEqual(self.scope.ensure_point_allowed.call_count, 2)
        self.frappe.db.sql.assert_called_once()
        self.frappe.get_doc.return_value.insert.assert_not_called()

    def test_foreign_point_is_rejected_before_strategy_and_audit(self):
        self.scope.ensure_point_allowed.side_effect = self.frappe.PermissionError("foreign")
        with self.assertRaises(self.frappe.PermissionError):
            self.module.delete_entity("sales_receipt", "R1")
        self.frappe.db.rollback.assert_called_once()

    def test_shift_and_employee_foreign_scope_are_denied_before_handlers(self):
        self.scope.ensure_point_allowed.side_effect = self.frappe.PermissionError("foreign point")
        with self.assertRaises(self.frappe.PermissionError):
            self.module.delete_entity("sales_shift", "SHIFT-FOREIGN")
        self.frappe.get_all.assert_not_called()
        self.scope.ensure_point_allowed.side_effect = None
        self.scope.ensure_entity_allowed.side_effect = self.frappe.PermissionError("foreign entity")
        with self.assertRaises(self.frappe.PermissionError):
            self.module.delete_entity("employee", "EMP-FOREIGN")
        self.frappe.get_all.assert_not_called()

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

    def test_sale_with_submitted_return_blocks_without_cascade(self):
        doc = MagicMock(doctype="Sales Receipt", docstatus=1, receipt_type="Sale")
        doc.name = "SALE-1"
        self.frappe.get_all.side_effect = lambda doctype, **kwargs: (
            ["RETURN-1"] if doctype == "Sales Receipt" else []
        )
        result = self.module._sales_receipt(doc, execute=True)
        self.assertEqual(result["dependencies"]["Sales Receipt Return"]["names"], ["RETURN-1"])
        self.assertFalse(result["can_delete"])
        doc.cancel.assert_not_called()

    def test_purchase_order_blocks_receipts_and_allocations(self):
        doc = MagicMock(doctype="Purchase Order", docstatus=1)
        doc.name = "PO-1"
        self.frappe.get_all.side_effect = lambda doctype, **kwargs: {
            "Stock Receipt": ["SR-1"], "Supplier Payment Allocation": ["PA-1"],
        }.get(doctype, [])
        result = self.module._purchase_order(doc, execute=True)
        self.assertEqual(set(result["dependencies"]), {"Stock Receipt", "Supplier Payment Allocation"})
        doc.cancel.assert_not_called()

    def test_submitted_documents_cancel_and_drafts_only_hard_delete(self):
        cases = (
            ("Sales Receipt", self.module._sales_receipt),
            ("Cash Movement", self.module._cash_movement),
            ("Stock Receipt", self.module._stock_receipt),
            ("Stock Write Off", self.module._stock_write_off),
            ("Stock Inventory", self.module._stock_inventory),
            ("Purchase Order", self.module._purchase_order),
        )
        for doctype, handler in cases:
            with self.subTest(doctype=doctype):
                doc = MagicMock(doctype=doctype, docstatus=1)
                doc.name = "DOC-1"
                doc.receipt_type = "Return"
                doc.purchase_order = None
                with patch.object(self.module, "_affected_after_cancel", return_value=[]):
                    result = handler(doc, execute=True)
                self.assertEqual(result["strategy"], "cancel")
                doc.cancel.assert_called_once()
                self.frappe.delete_doc.assert_not_called()
                self.frappe.delete_doc.reset_mock()
        draft = MagicMock(doctype="Stock Receipt", docstatus=0)
        draft.name = "DRAFT-1"
        result = self.module._stock_receipt(draft, execute=True)
        self.assertEqual(result["strategy"], "hard_delete")
        self.frappe.delete_doc.assert_called_once_with("Stock Receipt", "DRAFT-1", ignore_permissions=True)

    def test_shift_dependency_counts_include_all_sources_and_business_actions(self):
        doc = MagicMock(doctype="Sales Shift", business_entity="E1", business_point="P1")
        doc.name = "SHIFT-1"
        self.frappe.get_all.side_effect = lambda doctype, **kwargs: (
            ["R1", "R2"] if doctype == "Sales Receipt" else
            ["C1"] if doctype == "Cash Movement" else
            [types.SimpleNamespace(name="A1", action_type="SALE", shift=doc.name,
                                   business_entity="E1", business_point="P1",
                                   reference_doctype="Sales Receipt", reference_document="R1")]
            if doctype == "Cashier Action" else []
        )
        for source in ("POS", "MoySklad", "Manual", "Import"):
            with self.subTest(source=source):
                doc.source = source
                result = self.module._sales_shift(doc, execute=True)
                self.assertEqual(result["dependencies"]["Sales Receipt"],
                                 {"count": 2, "names": ["R1", "R2"]})
                self.assertEqual(result["dependencies"]["Cash Movement"],
                                 {"count": 1, "names": ["C1"]})
                self.assertEqual(result["dependencies"]["Cashier Action"]["names"], ["A1"])
        self.frappe.delete_doc.assert_not_called()

    def test_shift_deletes_only_actions_owned_by_shift(self):
        doc = MagicMock(doctype="Sales Shift", business_entity="E1", business_point="P1")
        doc.name = "SHIFT-1"
        technical = types.SimpleNamespace(
            name="A-OPEN", action_type="OPEN_SHIFT", shift=doc.name,
            business_entity="E1", business_point="P1",
            reference_doctype="Sales Shift", reference_document=doc.name,
        )
        self.frappe.get_all.side_effect = lambda doctype, **kwargs: (
            [technical] if doctype == "Cashier Action" else []
        )
        preview = self.module._sales_shift(doc)
        self.assertEqual(preview["strategy"], "hard_delete")
        self.assertTrue(preview["can_delete"])
        self.assertFalse(preview["deleted"])
        self.module._sales_shift(doc, execute=True)
        self.assertEqual(self.frappe.delete_doc.call_args_list[0].args, ("Cashier Action", "A-OPEN"))
        self.assertEqual(self.frappe.delete_doc.call_args_list[1].args, ("Sales Shift", doc.name))

    def test_employee_open_shift_blocks_archive_and_profile_is_preserved(self):
        doc = MagicMock(doctype="Employee", business_entity="E1")
        doc.name = "EMP-1"
        doc.get.side_effect = lambda key: {"system_user_profile": "PROFILE-1", "user": "web@example.test"}.get(key)
        self.frappe.get_all.side_effect = lambda doctype, **kwargs: (
            ["SHIFT-1"] if doctype == "Sales Shift" else []
        )
        blocked = self.module._employee(doc, execute=True)
        self.assertEqual(blocked["dependencies"]["Sales Shift"]["names"], ["SHIFT-1"])
        doc.save.assert_not_called()
        self.frappe.get_all.side_effect = lambda doctype, **kwargs: (
            ["SHIFT-1"] if doctype == "Sales Shift" and "status" not in kwargs["filters"] else []
        )
        archived = self.module._employee(doc, execute=True)
        self.assertEqual(archived["strategy"], "deactivate")
        self.assertEqual((doc.active, doc.pos_access_enabled), (0, 0))
        self.assertEqual(len(archived["warnings"]), 2)
        doc.save.assert_called_once_with(ignore_permissions=True)
        self.frappe.delete_doc.assert_not_called()

    def test_employee_without_history_is_hard_deleted(self):
        doc = MagicMock(doctype="Employee")
        doc.name = "EMP-EMPTY"
        doc.get.return_value = None
        result = self.module._employee(doc, execute=True)
        self.assertEqual(result["strategy"], "hard_delete")
        self.frappe.delete_doc.assert_called_once_with("Employee", doc.name, ignore_permissions=True)

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

    def test_deleted_shift_cannot_be_recreated_by_pos_ingest_or_legacy_path(self):
        source = MODULE.parent / "api" / "sales.py"
        fn = next(node for node in ast.parse(source.read_text()).body
                  if isinstance(node, ast.FunctionDef) and node.name == "_ingest_shift")
        namespace = {
            "_required": lambda row, field: row[field],
            "is_external_event_suppressed": lambda source, external_id: True,
            "frappe": self.frappe,
        }
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(source), "exec"), namespace)
        stats = {"duplicates": 0}
        namespace["_ingest_shift"]({"external_id": "OLD-SHIFT"}, object(), stats)
        self.assertEqual(stats["duplicates"], 1)
        self.frappe.db.get_value.assert_not_called()

        legacy = MODULE.parent / "api" / "pos.py"
        fn = next(node for node in ast.parse(legacy.read_text()).body
                  if isinstance(node, ast.FunctionDef) and node.name == "_get_or_create_legacy_shift")
        namespace = {"is_external_event_suppressed": lambda source, external_id: True,
                     "frappe": self.frappe, "_": lambda message: message}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(legacy), "exec"), namespace)
        with self.assertRaisesRegex(Exception, "Удалённая смена"):
            namespace["_get_or_create_legacy_shift"](
                types.SimpleNamespace(name="WORKPLACE"), "OLD-SHIFT",
                types.SimpleNamespace(date=lambda: "2026-09-24"),
            )
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
