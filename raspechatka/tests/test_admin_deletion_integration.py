"""DEV-181: real Frappe documents and balances around administrator cancellation."""
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_to_date, now_datetime

from raspechatka.deletion import delete_entity, get_delete_preview, is_external_event_suppressed
from raspechatka.api import moysklad_sales, sales as sales_ingest
from raspechatka.stock import get_balance


class TestAdminOperationalDeletion(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.previous_user = frappe.session.user
        frappe.set_user("Administrator")
        suffix = uuid4().hex[:10]
        self.entity = self._raw("Business Entity", f"TEST-DEL-BE-{suffix}")
        self.point = self._raw("Business Point", f"TEST-DEL-PT-{suffix}",
                               business_entity=self.entity, active=1)
        self.warehouse = self._raw("Catalog Warehouse", f"TEST-DEL-WH-{suffix}",
                                   business_point=self.point, active=1)
        self.supplier = self._raw("Catalog Supplier", f"TEST-DEL-SUP-{suffix}", active=1)
        self.uom = self._raw("Catalog Unit", f"TEST-DEL-UOM-{suffix}")
        self.item = self._raw("Catalog Item", f"TEST-DEL-ITEM-{suffix}",
                              item_name="Тестовая бумага", item_code=f"TEST-DEL-ITEM-{suffix}",
                              item_type="Product", stock_uom=self.uom, track_inventory=1,
                              active=1, has_variants=0)
        self.shift = self._raw(
            "Sales Shift", f"TEST-DEL-SHIFT-{suffix}",
            status="Open", opened_at=add_to_date(now_datetime(), minutes=-10),
            business_entity=self.entity, business_point=self.point,
            warehouse=self.warehouse, source="POS",
        )

    def tearDown(self):
        frappe.set_user(self.previous_user)
        super().tearDown()

    def _raw(self, doctype, name, **values):
        doc = frappe.get_doc({"doctype": doctype, "name": name, **values})
        doc.db_insert()
        return doc.name

    def _balance(self):
        result = get_balance(self.item, self.warehouse)
        return (float(result["qty"]), float(result["value"]))

    def _receipt(self, quantity=10, rate=100, *, purchase_order=None, source="Manual",
                 external_id=None, mirror=False):
        doc = frappe.get_doc({
            "doctype": "Stock Receipt", "receipt_type": "Приёмка" if purchase_order else "Оприходование",
            "posting_datetime": add_to_date(now_datetime(), seconds=-30),
            "business_entity": self.entity, "business_point": self.point,
            "warehouse": self.warehouse, "supplier": self.supplier if purchase_order else None,
            "purchase_order": purchase_order, "reason": "DEV-181 test",
            "source": source, "external_id": external_id,
            "items": [{"item": self.item, "quantity": quantity, "rate": rate,
                       **({"purchase_order_item": frappe.get_doc("Purchase Order", purchase_order).items[0].name}
                          if purchase_order else {})}],
        })
        doc.flags.ignore_stock_chronology = True
        doc.insert(ignore_permissions=True)
        doc.flags.ignore_stock_chronology = True
        doc.submit()
        return doc

    def _sale(self, *, mirror=False):
        doc = frappe.get_doc({
            "doctype": "Sales Receipt", "receipt_type": "Sale",
            "posting_datetime": now_datetime(), "shift": self.shift,
            "business_entity": self.entity, "business_point": self.point,
            "warehouse": self.warehouse, "source": "MoySklad" if mirror else "POS",
            "external_id": f"moysklad:retaildemand:{uuid4().hex}" if mirror else f"POS-{uuid4().hex}",
            "mirror_only": int(mirror),
            "client": self._raw("Client", f"TEST-DEL-CLIENT-{uuid4().hex[:10]}",
                                first_name="Тест", phone=f"+79{uuid4().int % 1000000000:09d}",
                                registration_point=self.point),
            "items": [{"item": self.item, "quantity": 2, "unit_price": 150}],
            "payments": [{"payment_channel": "Cash", "amount": 300}],
        })
        doc.insert(ignore_permissions=True)
        doc.submit()
        return doc

    def test_receipt_reverts_exact_quantity_value_and_order_received(self):
        opening = self._receipt(quantity=5, rate=100)
        self.assertEqual(self._balance(), (5, 500))
        order = frappe.get_doc({
            "doctype": "Purchase Order", "business_entity": self.entity,
            "business_point": self.point, "warehouse": self.warehouse,
            "supplier": self.supplier,
            "items": [{"item": self.item, "quantity": 10, "rate": 120}],
        }).insert(ignore_permissions=True)
        order.submit()
        receipt = self._receipt(quantity=10, rate=120, purchase_order=order.name)
        self.assertEqual(self._balance(), (15, 1700))
        order.reload()
        self.assertEqual(float(order.received_quantity), 10)
        self.assertEqual(get_delete_preview("stock_receipt", receipt.name)["strategy"], "cancel")
        self.assertEqual(delete_entity("stock_receipt", receipt.name)["strategy"], "cancel")
        self.assertEqual(self._balance(), (5, 500))
        order.reload()
        self.assertEqual(float(order.received_quantity), 0)
        self.assertEqual(frappe.db.get_value("Stock Receipt", receipt.name, "docstatus"), 2)
        self.assertEqual(frappe.db.get_value("Stock Receipt", opening.name, "docstatus"), 1)

    def test_write_off_and_inventory_restore_quantity_and_value(self):
        self._receipt(quantity=10, rate=100)
        baseline = self._balance()
        off = frappe.get_doc({
            "doctype": "Stock Write Off", "business_entity": self.entity,
            "business_point": self.point, "warehouse": self.warehouse,
            "posting_datetime": now_datetime(), "reason": "DEV-181 test", "source": "Manual",
            "items": [{"item": self.item, "quantity": 2}],
        }).insert(ignore_permissions=True)
        off.submit()
        self.assertEqual(self._balance(), (8, 800))
        delete_entity("stock_write_off", off.name)
        self.assertEqual(self._balance(), baseline)
        inventory = frappe.get_doc({
            "doctype": "Stock Inventory", "business_entity": self.entity,
            "business_point": self.point, "warehouse": self.warehouse,
            "posting_datetime": now_datetime(), "source": "Manual",
            "items": [{"item": self.item, "counted_quantity": 7}],
        }).insert(ignore_permissions=True)
        inventory.submit()
        self.assertEqual(self._balance(), (7, 700))
        delete_entity("stock_inventory", inventory.name)
        self.assertEqual(self._balance(), baseline)

    def test_pos_sale_reverts_stock_profit_client_and_shift_and_tombstones(self):
        self._receipt(quantity=10, rate=100)
        baseline = self._balance()
        sale = self._sale()
        self.assertEqual(self._balance(), (8, 800))
        self.assertTrue(frappe.db.exists("Client Purchase", {"source_document": sale.name}))
        self.assertGreater(float(frappe.db.get_value("Sales Shift", self.shift, "net_sales")), 0)
        self.assertNotEqual(
            sum(float(v) for v in frappe.get_all(
                "Profitability Entry", filters={"source_document": sale.name}, pluck="revenue"
            )), 0,
        )
        delete_entity("sales_receipt", sale.name)
        self.assertEqual(self._balance(), baseline)
        self.assertEqual(float(frappe.db.get_value("Sales Shift", self.shift, "net_sales")), 0)
        self.assertEqual(frappe.db.get_value("Client Purchase",
                                            {"source_document": sale.name}, "cancelled"), 1)
        self.assertEqual(
            sum(float(v) for v in frappe.get_all(
                "Profitability Entry", filters={"source_document": sale.name}, pluck="revenue"
            )), 0,
        )
        self.assertTrue(is_external_event_suppressed("POS", sale.external_id))
        self.assertEqual(frappe.db.get_value("Sales Receipt", sale.name, "docstatus"), 2)
        stats = {"created": 0, "duplicates": 0, "errors": []}
        sales_ingest._ingest_receipt({"external_id": sale.external_id},
                                     SimpleNamespace(business_point=self.point), stats)
        self.assertEqual(stats["duplicates"], 1)
        self.assertEqual(frappe.db.count("Sales Receipt", {"external_id": sale.external_id}), 1)

    def test_moysklad_mirror_cancel_never_posts_physical_reversal(self):
        self._receipt(quantity=10, rate=100)
        before = self._balance()
        sale = self._sale(mirror=True)
        self.assertEqual(self._balance(), before)
        delete_entity("sales_receipt", sale.name)
        self.assertEqual(self._balance(), before)
        self.assertEqual(frappe.db.count("Stock Ledger Entry", {
            "voucher_type": "Sales Receipt", "voucher_no": sale.name,
        }), 0)
        self.assertTrue(is_external_event_suppressed("MoySklad", sale.external_id))
        stats = {"duplicates": 0}
        moysklad_sales._upsert_receipt(
            {"id": sale.external_id.rsplit(":", 1)[-1]}, {"stats": stats}
        )
        self.assertEqual(stats["duplicates"], 1)
        self.assertEqual(frappe.db.count("Sales Receipt", {"external_id": sale.external_id}), 1)

    def test_sale_with_submitted_return_blocks_without_changing_effects(self):
        self._receipt(quantity=10, rate=100)
        sale = self._sale()
        returned = frappe.get_doc({
            "doctype": "Sales Receipt", "receipt_type": "Return",
            "original_receipt": sale.name, "posting_datetime": now_datetime(),
            "shift": self.shift, "business_entity": self.entity,
            "business_point": self.point, "warehouse": self.warehouse,
            "source": "POS", "external_id": f"POS-RETURN-{uuid4().hex}",
            "items": [{"item": self.item, "quantity": 1, "unit_price": 150}],
            "payments": [{"payment_channel": "Cash", "amount": 150}],
        }).insert(ignore_permissions=True)
        returned.submit()
        before = self._balance()
        preview = get_delete_preview("sales_receipt", sale.name)
        self.assertFalse(preview["can_delete"])
        self.assertIn(returned.name, preview["dependencies"]["Sales Receipt Return"]["names"])
        self.assertFalse(delete_entity("sales_receipt", sale.name)["deleted"])
        self.assertEqual(self._balance(), before)
        self.assertEqual(frappe.db.get_value("Sales Receipt", sale.name, "docstatus"), 1)

    def test_purchase_order_dependencies_and_safe_draft_removal(self):
        draft = frappe.get_doc({
            "doctype": "Purchase Order", "business_entity": self.entity,
            "business_point": self.point, "warehouse": self.warehouse,
            "supplier": self.supplier,
            "items": [{"item": self.item, "quantity": 10, "rate": 120}],
        }).insert(ignore_permissions=True)
        self.assertEqual(delete_entity("purchase_order", draft.name)["strategy"], "hard_delete")
        self.assertFalse(frappe.db.exists("Purchase Order", draft.name))
        unlinked = frappe.get_doc({
            "doctype": "Purchase Order", "business_entity": self.entity,
            "business_point": self.point, "warehouse": self.warehouse,
            "supplier": self.supplier,
            "items": [{"item": self.item, "quantity": 1, "rate": 120}],
        }).insert(ignore_permissions=True)
        unlinked.submit()
        self.assertEqual(delete_entity("purchase_order", unlinked.name)["strategy"], "cancel")
        self.assertEqual(frappe.db.get_value("Purchase Order", unlinked.name, "docstatus"), 2)
        order = frappe.get_doc({
            "doctype": "Purchase Order", "business_entity": self.entity,
            "business_point": self.point, "warehouse": self.warehouse,
            "supplier": self.supplier,
            "items": [{"item": self.item, "quantity": 10, "rate": 120}],
        }).insert(ignore_permissions=True)
        order.submit()
        receipt = self._receipt(purchase_order=order.name)
        result = get_delete_preview("purchase_order", order.name)
        self.assertFalse(result["can_delete"])
        self.assertIn(receipt.name, result["dependencies"]["Stock Receipt"]["names"])
        self.assertFalse(delete_entity("purchase_order", order.name)["deleted"])
        self.assertEqual(frappe.db.get_value("Purchase Order", order.name, "docstatus"), 1)

    def test_safe_draft_stock_receipt_has_no_stock_effect(self):
        before = self._balance()
        draft = frappe.get_doc({
            "doctype": "Stock Receipt", "receipt_type": "Оприходование",
            "business_entity": self.entity, "business_point": self.point,
            "warehouse": self.warehouse, "reason": "DEV-181 draft",
            "items": [{"item": self.item, "quantity": 10, "rate": 100}],
        }).insert(ignore_permissions=True)
        self.assertEqual(delete_entity("stock_receipt", draft.name)["strategy"], "hard_delete")
        self.assertFalse(frappe.db.exists("Stock Receipt", draft.name))
        self.assertEqual(self._balance(), before)

    def test_collection_cancels_finance_transaction_and_restores_shift(self):
        article = frappe.db.get_value("Financial Article", {"article_name": "Выручка", "active": 1},
                                      "name")
        if not article:
            self._raw("Financial Article", f"TEST-DEL-ARTICLE-{uuid4().hex[:10]}",
                      article_name="Выручка", article_type="Income", active=1)
        movement = frappe.get_doc({
            "doctype": "Cash Movement", "movement_type": "Withdrawal",
            "withdrawal_purpose": "Collection", "posting_datetime": now_datetime(),
            "shift": self.shift, "business_entity": self.entity, "business_point": self.point,
            "source": "POS", "external_id": f"POS-CASH-{uuid4().hex}",
            "amount": 50, "reason": "DEV-181 collection",
        }).insert(ignore_permissions=True)
        movement.submit()
        transaction = frappe.db.get_value("Finance Transaction", {"cash_movement": movement.name}, "name")
        self.assertTrue(transaction)
        self.assertEqual(frappe.db.get_value("Finance Transaction", transaction, "docstatus"), 1)
        delete_entity("cash_movement", movement.name)
        self.assertEqual(frappe.db.get_value("Finance Transaction", transaction, "docstatus"), 2)
        self.assertEqual(float(frappe.db.get_value("Sales Shift", self.shift, "expected_cash")), 0)
        self.assertTrue(is_external_event_suppressed("POS", movement.external_id))

    def test_failed_cancellation_rolls_back_all_stock_changes(self):
        self._receipt(quantity=10, rate=100)
        receipt = self._receipt(quantity=2, rate=120)
        before = self._balance()
        original_rollback = frappe.db.rollback
        savepoint = f"dev181_{uuid4().hex[:12]}"
        frappe.db.savepoint(savepoint)
        from raspechatka.raspechatka_os.doctype.stock_receipt.stock_receipt import StockReceipt

        original_cancel = StockReceipt.on_cancel

        def fail_after_effects(doc):
            original_cancel(doc)
            raise RuntimeError("Injected failure after stock reversal")

        def rollback_request(*args, **kwargs):
            return original_rollback(save_point=savepoint)

        with (patch.object(StockReceipt, "on_cancel", fail_after_effects),
              patch.object(frappe.db, "rollback", side_effect=rollback_request),
              patch.object(frappe.db, "commit")):
            with self.assertRaisesRegex(RuntimeError, "Injected failure"):
                delete_entity("stock_receipt", receipt.name)
        self.assertEqual(self._balance(), before)
        self.assertEqual(frappe.db.get_value("Stock Receipt", receipt.name, "docstatus"), 1)
        self.assertFalse(frappe.db.exists("Stock Ledger Entry", {
            "voucher_type": "Stock Receipt", "voucher_no": receipt.name, "is_reversal": 1,
        }))
