"""DEV-181: real Frappe documents and balances around administrator cancellation."""

from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_to_date, now_datetime

from raspechatka.api import moysklad_sales
from raspechatka.api import sales as sales_ingest
from raspechatka.api.team import save_employee
from raspechatka.deletion import delete_entity, get_delete_preview, is_external_event_suppressed
from raspechatka.sales import log_cashier_action
from raspechatka.stock import get_balance


class TestAdminOperationalDeletion(FrappeTestCase):
	def setUp(self):
		super().setUp()
		self.previous_user = frappe.session.user
		frappe.set_user("Administrator")
		suffix = uuid4().hex[:10]
		self.entity = self._raw("Business Entity", f"TEST-DEL-BE-{suffix}", active=1)
		self.point = self._raw(
			"Business Point",
			f"TEST-DEL-PT-{suffix}",
			business_entity=self.entity,
			point_name="Тестовая точка",
			city="Тестовый город",
			address="Тестовая улица, 1",
			active=1,
		)
		self.warehouse = self._raw(
			"Catalog Warehouse", f"TEST-DEL-WH-{suffix}", business_point=self.point, active=1
		)
		self.supplier = self._raw("Catalog Supplier", f"TEST-DEL-SUP-{suffix}", active=1)
		self.uom = self._raw("Catalog Unit", f"TEST-DEL-UOM-{suffix}")
		self.item = self._raw(
			"Catalog Item",
			f"TEST-DEL-ITEM-{suffix}",
			item_name="Тестовая бумага",
			item_code=f"TEST-DEL-ITEM-{suffix}",
			item_type="Product",
			stock_uom=self.uom,
			track_inventory=1,
			active=1,
			has_variants=0,
		)
		self.shift = self._raw(
			"Sales Shift",
			f"TEST-DEL-SHIFT-{suffix}",
			status="Open",
			opened_at=add_to_date(now_datetime(), minutes=-10),
			business_entity=self.entity,
			business_point=self.point,
			warehouse=self.warehouse,
			source="POS",
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

	def _receipt(
		self, quantity=10, rate=100, *, purchase_order=None, source="Manual", external_id=None, mirror=False
	):
		doc = frappe.get_doc(
			{
				"doctype": "Stock Receipt",
				"receipt_type": "Приёмка" if purchase_order else "Оприходование",
				"posting_datetime": add_to_date(now_datetime(), seconds=-30),
				"business_entity": self.entity,
				"business_point": self.point,
				"warehouse": self.warehouse,
				"supplier": self.supplier if purchase_order else None,
				"purchase_order": purchase_order,
				"reason": "DEV-181 test",
				"source": source,
				"external_id": external_id,
				"items": [
					{
						"item": self.item,
						"quantity": quantity,
						"rate": rate,
						**(
							{
								"purchase_order_item": frappe.get_doc("Purchase Order", purchase_order)
								.items[0]
								.name
							}
							if purchase_order
							else {}
						),
					}
				],
			}
		)
		doc.flags.ignore_stock_chronology = True
		doc.insert(ignore_permissions=True)
		doc.flags.ignore_stock_chronology = True
		doc.submit()
		return doc

	def _sale(self, *, mirror=False):
		doc = frappe.get_doc(
			{
				"doctype": "Sales Receipt",
				"receipt_type": "Sale",
				"posting_datetime": now_datetime(),
				"shift": self.shift,
				"business_entity": self.entity,
				"business_point": self.point,
				"warehouse": self.warehouse,
				"cashier": frappe.db.get_value("Sales Shift", self.shift, "cashier"),
				"source": "MoySklad" if mirror else "POS",
				"external_id": f"moysklad:retaildemand:{uuid4().hex}" if mirror else f"POS-{uuid4().hex}",
				"mirror_only": int(mirror),
				"client": self._raw(
					"Client",
					f"TEST-DEL-CLIENT-{uuid4().hex[:10]}",
					first_name="Тест",
					phone=f"+79{uuid4().int % 1000000000:09d}",
					registration_point=self.point,
				),
				"items": [{"item": self.item, "quantity": 2, "unit_price": 150}],
				"payments": [{"payment_channel": "Cash", "amount": 300}],
			}
		)
		doc.insert(ignore_permissions=True)
		doc.submit()
		return doc

	def _employee(self, *, pos_access=0):
		position = self._raw(
			"Position",
			f"TEST-DEL-POSITION-{uuid4().hex[:10]}",
			position_name=f"Тестовая должность {uuid4().hex[:10]}",
		)
		return frappe.get_doc(
			{
				"doctype": "Employee",
				"last_name": "Тестов",
				"first_name": "Кассир",
				"phone": f"+79{uuid4().int % 1000000000:09d}",
				"business_entity": self.entity,
				"position": position,
				"active": 1,
				"pos_access_enabled": pos_access,
				"assigned_points": [{"business_point": self.point, "is_default": 1}],
			}
		).insert(ignore_permissions=True)

	def test_receipt_reverts_exact_quantity_value_and_order_received(self):
		opening = self._receipt(quantity=5, rate=100)
		self.assertEqual(self._balance(), (5, 500))
		order = frappe.get_doc(
			{
				"doctype": "Purchase Order",
				"business_entity": self.entity,
				"business_point": self.point,
				"warehouse": self.warehouse,
				"supplier": self.supplier,
				"items": [{"item": self.item, "quantity": 10, "rate": 120}],
			}
		).insert(ignore_permissions=True)
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
		off = frappe.get_doc(
			{
				"doctype": "Stock Write Off",
				"business_entity": self.entity,
				"business_point": self.point,
				"warehouse": self.warehouse,
				"posting_datetime": now_datetime(),
				"reason": "DEV-181 test",
				"source": "Manual",
				"items": [{"item": self.item, "quantity": 2}],
			}
		).insert(ignore_permissions=True)
		off.submit()
		self.assertEqual(self._balance(), (8, 800))
		delete_entity("stock_write_off", off.name)
		self.assertEqual(self._balance(), baseline)
		inventory = frappe.get_doc(
			{
				"doctype": "Stock Inventory",
				"business_entity": self.entity,
				"business_point": self.point,
				"warehouse": self.warehouse,
				"posting_datetime": now_datetime(),
				"source": "Manual",
				"items": [{"item": self.item, "counted_quantity": 7}],
			}
		).insert(ignore_permissions=True)
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
			sum(
				float(v)
				for v in frappe.get_all(
					"Profitability Entry", filters={"source_document": sale.name}, pluck="revenue"
				)
			),
			0,
		)
		delete_entity("sales_receipt", sale.name)
		self.assertEqual(self._balance(), baseline)
		self.assertEqual(float(frappe.db.get_value("Sales Shift", self.shift, "net_sales")), 0)
		self.assertEqual(
			frappe.db.get_value("Client Purchase", {"source_document": sale.name}, "cancelled"), 1
		)
		self.assertEqual(
			sum(
				float(v)
				for v in frappe.get_all(
					"Profitability Entry", filters={"source_document": sale.name}, pluck="revenue"
				)
			),
			0,
		)
		self.assertTrue(is_external_event_suppressed("POS", sale.external_id))
		self.assertEqual(frappe.db.get_value("Sales Receipt", sale.name, "docstatus"), 2)
		stats = {"created": 0, "duplicates": 0, "errors": []}
		sales_ingest._ingest_receipt(
			{"external_id": sale.external_id}, SimpleNamespace(business_point=self.point), stats
		)
		self.assertEqual(stats["duplicates"], 1)
		self.assertEqual(frappe.db.count("Sales Receipt", {"external_id": sale.external_id}), 1)

	def test_moysklad_mirror_cancel_never_posts_physical_reversal(self):
		self._receipt(quantity=10, rate=100)
		before = self._balance()
		sale = self._sale(mirror=True)
		self.assertEqual(self._balance(), before)
		delete_entity("sales_receipt", sale.name)
		self.assertEqual(self._balance(), before)
		self.assertEqual(
			frappe.db.count(
				"Stock Ledger Entry",
				{
					"voucher_type": "Sales Receipt",
					"voucher_no": sale.name,
				},
			),
			0,
		)
		self.assertTrue(is_external_event_suppressed("MoySklad", sale.external_id))
		stats = {"duplicates": 0}
		moysklad_sales._upsert_receipt({"id": sale.external_id.rsplit(":", 1)[-1]}, {"stats": stats})
		self.assertEqual(stats["duplicates"], 1)
		self.assertEqual(frappe.db.count("Sales Receipt", {"external_id": sale.external_id}), 1)

	def test_sale_with_submitted_return_blocks_without_changing_effects(self):
		self._receipt(quantity=10, rate=100)
		sale = self._sale()
		returned = frappe.get_doc(
			{
				"doctype": "Sales Receipt",
				"receipt_type": "Return",
				"original_receipt": sale.name,
				"posting_datetime": now_datetime(),
				"shift": self.shift,
				"business_entity": self.entity,
				"business_point": self.point,
				"warehouse": self.warehouse,
				"source": "POS",
				"external_id": f"POS-RETURN-{uuid4().hex}",
				"items": [{"item": self.item, "quantity": 1, "unit_price": 150}],
				"payments": [{"payment_channel": "Cash", "amount": 150}],
			}
		).insert(ignore_permissions=True)
		returned.submit()
		before = self._balance()
		preview = get_delete_preview("sales_receipt", sale.name)
		self.assertFalse(preview["can_delete"])
		self.assertIn(returned.name, preview["dependencies"]["Sales Receipt Return"]["names"])
		self.assertFalse(delete_entity("sales_receipt", sale.name)["deleted"])
		self.assertEqual(self._balance(), before)
		self.assertEqual(frappe.db.get_value("Sales Receipt", sale.name, "docstatus"), 1)

	def test_purchase_order_dependencies_and_safe_draft_removal(self):
		draft = frappe.get_doc(
			{
				"doctype": "Purchase Order",
				"business_entity": self.entity,
				"business_point": self.point,
				"warehouse": self.warehouse,
				"supplier": self.supplier,
				"items": [{"item": self.item, "quantity": 10, "rate": 120}],
			}
		).insert(ignore_permissions=True)
		self.assertEqual(delete_entity("purchase_order", draft.name)["strategy"], "hard_delete")
		self.assertFalse(frappe.db.exists("Purchase Order", draft.name))
		unlinked = frappe.get_doc(
			{
				"doctype": "Purchase Order",
				"business_entity": self.entity,
				"business_point": self.point,
				"warehouse": self.warehouse,
				"supplier": self.supplier,
				"items": [{"item": self.item, "quantity": 1, "rate": 120}],
			}
		).insert(ignore_permissions=True)
		unlinked.submit()
		self.assertEqual(delete_entity("purchase_order", unlinked.name)["strategy"], "cancel")
		self.assertEqual(frappe.db.get_value("Purchase Order", unlinked.name, "docstatus"), 2)
		order = frappe.get_doc(
			{
				"doctype": "Purchase Order",
				"business_entity": self.entity,
				"business_point": self.point,
				"warehouse": self.warehouse,
				"supplier": self.supplier,
				"items": [{"item": self.item, "quantity": 10, "rate": 120}],
			}
		).insert(ignore_permissions=True)
		order.submit()
		receipt = self._receipt(purchase_order=order.name)
		result = get_delete_preview("purchase_order", order.name)
		self.assertFalse(result["can_delete"])
		self.assertIn(receipt.name, result["dependencies"]["Stock Receipt"]["names"])
		self.assertFalse(delete_entity("purchase_order", order.name)["deleted"])
		self.assertEqual(frappe.db.get_value("Purchase Order", order.name, "docstatus"), 1)

	def test_safe_draft_stock_receipt_has_no_stock_effect(self):
		before = self._balance()
		draft = frappe.get_doc(
			{
				"doctype": "Stock Receipt",
				"receipt_type": "Оприходование",
				"business_entity": self.entity,
				"business_point": self.point,
				"warehouse": self.warehouse,
				"reason": "DEV-181 draft",
				"items": [{"item": self.item, "quantity": 10, "rate": 100}],
			}
		).insert(ignore_permissions=True)
		self.assertEqual(delete_entity("stock_receipt", draft.name)["strategy"], "hard_delete")
		self.assertFalse(frappe.db.exists("Stock Receipt", draft.name))
		self.assertEqual(self._balance(), before)

	def test_empty_old_pos_shift_delete_unblocks_employee_checkbox_and_replay(self):
		employee = self._employee(pos_access=1)
		external_id = f"POS-OLD-SHIFT-{uuid4().hex}"
		frappe.db.set_value(
			"Sales Shift",
			self.shift,
			{
				"cashier": employee.name,
				"external_id": external_id,
				"source": "POS",
				"status": "Open",
			},
		)
		shift = frappe.get_doc("Sales Shift", self.shift)
		log_cashier_action(shift, "OPEN_SHIFT", f"{external_id}:open")
		action = frappe.db.get_value("Cashier Action", {"shift": shift.name}, "name")
		change = {
			"name": employee.name,
			"business_entity": self.entity,
			"active": 1,
			"pos_access_enabled": 0,
			"assigned_points": [{"business_point": self.point, "is_default": 1}],
		}
		with self.assertRaises(frappe.ValidationError):
			save_employee(change)
		self.assertEqual(frappe.db.get_value("Employee", employee.name, "pos_access_enabled"), 1)
		preview = get_delete_preview("sales_shift", shift.name)
		self.assertEqual(preview["strategy"], "hard_delete")
		self.assertTrue(preview["can_delete"])
		self.assertEqual(delete_entity("sales_shift", shift.name)["strategy"], "hard_delete")
		self.assertFalse(frappe.db.exists("Sales Shift", shift.name))
		self.assertFalse(frappe.db.exists("Cashier Action", action))
		self.assertTrue(is_external_event_suppressed("POS", external_id))
		self.assertEqual(save_employee(change)["name"], employee.name)
		self.assertEqual(frappe.db.get_value("Employee", employee.name, "pos_access_enabled"), 0)
		stats = {"created": 0, "duplicates": 0}
		sales_ingest._ingest_shift(
			{"external_id": external_id}, SimpleNamespace(business_point=self.point), stats
		)
		self.assertEqual(stats["duplicates"], 1)
		self.assertFalse(frappe.db.exists("Sales Shift", {"external_id": external_id}))

	def test_shift_business_dependencies_block_for_all_sources_with_exact_ids(self):
		for source in ("POS", "MoySklad", "Manual", "Import"):
			with self.subTest(source=source):
				shift = self._raw(
					"Sales Shift",
					f"TEST-DEL-SHIFT-{uuid4().hex[:10]}",
					business_entity=self.entity,
					business_point=self.point,
					warehouse=self.warehouse,
					status="Closed",
					source=source,
					opened_at=add_to_date(now_datetime(), minutes=-15),
					closed_at=add_to_date(now_datetime(), minutes=-5),
				)
				receipt = self._raw(
					"Sales Receipt",
					f"TEST-DEL-REC-{uuid4().hex[:10]}",
					shift=shift,
					business_entity=self.entity,
					business_point=self.point,
					docstatus=1,
				)
				movement = self._raw(
					"Cash Movement",
					f"TEST-DEL-CASH-{uuid4().hex[:10]}",
					shift=shift,
					business_entity=self.entity,
					business_point=self.point,
					docstatus=1,
				)
				preview = get_delete_preview("sales_shift", shift)
				self.assertEqual(preview["dependencies"]["Sales Receipt"], {"count": 1, "names": [receipt]})
				self.assertEqual(preview["dependencies"]["Cash Movement"], {"count": 1, "names": [movement]})
				self.assertFalse(delete_entity("sales_shift", shift)["deleted"])
				self.assertTrue(frappe.db.exists("Sales Shift", shift))

	def test_shift_business_action_is_never_removed_as_technical_cleanup(self):
		shift = frappe.get_doc("Sales Shift", self.shift)
		log_cashier_action(shift, "OPEN_SHIFT", f"TEST-OPEN-{uuid4().hex}")
		log_cashier_action(shift, "REVIEW_RECEIVED", f"TEST-REVIEW-{uuid4().hex}")
		log_cashier_action(shift, "DISCOUNT", f"TEST-DISCOUNT-{uuid4().hex}")
		action = frappe.db.get_value(
			"Cashier Action", {"shift": shift.name, "action_type": "REVIEW_RECEIVED"}, "name"
		)
		preview = get_delete_preview("sales_shift", shift.name)
		self.assertEqual(preview["strategy"], "archive")
		self.assertFalse(preview["dependencies"])
		closed_at = shift.closed_at
		self.assertEqual(delete_entity("sales_shift", shift.name)["strategy"], "archive")
		self.assertTrue(frappe.db.exists("Cashier Action", action))
		self.assertEqual(frappe.db.count("Cashier Action", {"shift": shift.name}), 3)
		self.assertEqual(frappe.db.get_value("Sales Shift", shift.name, "status"), "Cancelled")
		self.assertEqual(frappe.db.get_value("Sales Shift", shift.name, "closed_at"), closed_at)

	def test_cancelled_sale_then_shift_archives_without_losing_audit_or_pos_access(self):
		from raspechatka.api.sales import get_receipts, get_shift, get_shifts

		employee = self._employee(pos_access=1)
		external_id = f"POS-ARCHIVED-SHIFT-{uuid4().hex}"
		frappe.db.set_value(
			"Sales Shift",
			self.shift,
			{"cashier": employee.name, "source": "POS", "external_id": external_id, "status": "Open"},
		)
		shift = frappe.get_doc("Sales Shift", self.shift)
		log_cashier_action(shift, "OPEN_SHIFT", f"{external_id}:open")
		self._receipt(quantity=5)
		sale = self._sale()
		self.assertEqual(self._balance()[0], 3)
		self.assertIn(sale.name, [row.name for row in get_receipts(shift=self.shift)["rows"]])
		self.assertGreater(float(frappe.db.get_value("Sales Shift", self.shift, "net_sales")), 0)
		self.assertEqual(delete_entity("sales_receipt", sale.name)["strategy"], "cancel")
		self.assertEqual(frappe.db.get_value("Sales Receipt", sale.name, "docstatus"), 2)
		self.assertEqual(float(frappe.db.get_value("Sales Shift", self.shift, "net_sales")), 0)
		self.assertEqual(self._balance()[0], 5)
		self.assertNotIn(sale.name, [row.name for row in get_receipts(shift=self.shift)["rows"]])
		self.assertNotIn(sale.name, [row.name for row in get_shift(self.shift)["receipts"]])
		self.assertEqual(get_delete_preview("sales_shift", self.shift)["strategy"], "archive")
		self.assertEqual(delete_entity("sales_shift", self.shift)["strategy"], "archive")
		self.assertEqual(frappe.db.get_value("Sales Shift", self.shift, "status"), "Cancelled")
		self.assertIsNone(frappe.db.get_value("Sales Shift", self.shift, "closed_at"))
		self.assertTrue(frappe.db.exists("Sales Receipt", sale.name))
		actions = frappe.get_all("Cashier Action", filters={"shift": self.shift}, pluck="action_type")
		self.assertIn("SALE", actions)
		self.assertIn("CANCEL_RECEIPT", actions)
		self.assertIn("CANCEL_RECEIPT", [row.action_type for row in get_shift(self.shift)["actions"]])
		self.assertTrue(is_external_event_suppressed("POS", external_id))
		self.assertNotIn(self.shift, [row.name for row in get_shifts()["rows"]])
		self.assertIn(self.shift, [row.name for row in get_shifts(status="Cancelled")["rows"]])
		self.assertFalse(frappe.db.exists("Sales Shift", {"cashier": employee.name, "status": "Open"}))
		change = {
			"name": employee.name,
			"business_entity": self.entity,
			"active": 1,
			"pos_access_enabled": 0,
			"assigned_points": [{"business_point": self.point, "is_default": 1}],
		}
		self.assertEqual(save_employee(change)["name"], employee.name)
		self.assertEqual(frappe.db.get_value("Employee", employee.name, "pos_access_enabled"), 0)
		stats = {"created": 0, "duplicates": 0}
		sales_ingest._ingest_shift(
			{"external_id": external_id, "status": "Open"},
			SimpleNamespace(business_point=self.point),
			stats,
			update_existing=True,
		)
		self.assertEqual(stats["duplicates"], 1)
		self.assertEqual(frappe.db.get_value("Sales Shift", self.shift, "status"), "Cancelled")

	def test_cancelled_cash_movement_does_not_block_shift_archive(self):
		from raspechatka.api.sales import get_shift

		movement = frappe.get_doc(
			{
				"doctype": "Cash Movement",
				"movement_type": "Deposit",
				"posting_datetime": now_datetime(),
				"shift": self.shift,
				"business_entity": self.entity,
				"business_point": self.point,
				"cashier": frappe.db.get_value("Sales Shift", self.shift, "cashier"),
				"source": "POS",
				"external_id": f"POS-CASH-{uuid4().hex}",
				"amount": 50,
				"reason": "DEV-183 collection",
			}
		).insert(ignore_permissions=True)
		movement.submit()
		self.assertEqual(delete_entity("cash_movement", movement.name)["strategy"], "cancel")
		self.assertEqual(frappe.db.get_value("Cash Movement", movement.name, "docstatus"), 2)
		self.assertNotIn(movement.name, [row.name for row in get_shift(self.shift)["cash_movements"]])
		self.assertEqual(delete_entity("sales_shift", self.shift)["strategy"], "archive")
		self.assertTrue(frappe.db.exists("Cash Movement", movement.name))
		self.assertTrue(frappe.db.exists("Cashier Action", {"shift": self.shift}))

	def test_active_draft_and_submitted_documents_still_block_shift(self):
		cancelled = self._raw(
			"Sales Receipt",
			f"TEST-DEV183-CANCELLED-{uuid4().hex[:10]}",
			shift=self.shift,
			business_entity=self.entity,
			business_point=self.point,
			docstatus=2,
		)
		for doctype, status in (("Sales Receipt", 0), ("Cash Movement", 1)):
			name = self._raw(
				doctype,
				f"TEST-DEV183-{uuid4().hex[:10]}",
				shift=self.shift,
				business_entity=self.entity,
				business_point=self.point,
				docstatus=status,
			)
			preview = get_delete_preview("sales_shift", self.shift)
			self.assertEqual(preview["strategy"], "blocked")
			self.assertIn(name, preview["dependencies"][doctype]["names"])
			self.assertNotIn(cancelled, preview["dependencies"].get("Sales Receipt", {}).get("names", []))
			self.assertEqual(preview["message"], "Сначала удалите или отмените активные документы смены")
		self.assertFalse(delete_entity("sales_shift", self.shift)["deleted"])

	def test_moysklad_cancelled_document_archives_and_replay_is_suppressed(self):
		external_id = f"moysklad:retailshift:{uuid4().hex}"
		frappe.db.set_value("Sales Shift", self.shift, {"source": "MoySklad", "external_id": external_id})
		cancelled = self._raw(
			"Sales Receipt",
			f"TEST-DEV183-MS-{uuid4().hex[:10]}",
			shift=self.shift,
			business_entity=self.entity,
			business_point=self.point,
			docstatus=2,
		)
		self.assertEqual(delete_entity("sales_shift", self.shift)["strategy"], "archive")
		self.assertTrue(frappe.db.exists("Sales Receipt", cancelled))
		self.assertTrue(is_external_event_suppressed("MoySklad", external_id))
		stats = {"duplicates": 0}
		moysklad_sales._upsert_shift({"id": external_id.rsplit(":", 1)[-1]}, {"stats": stats})
		self.assertEqual(stats["duplicates"], 1)
		self.assertEqual(frappe.db.get_value("Sales Shift", self.shift, "status"), "Cancelled")

	def test_empty_shift_sources_share_rules_and_moysklad_replay_stays_suppressed(self):
		for source in ("POS", "MoySklad", "Manual", "Import"):
			with self.subTest(source=source):
				external_id = (
					f"moysklad:retailshift:{uuid4().hex}"
					if source == "MoySklad"
					else f"POS-SHIFT-{uuid4().hex}"
					if source == "POS"
					else None
				)
				shift = self._raw(
					"Sales Shift",
					f"TEST-DEL-EMPTY-{uuid4().hex[:10]}",
					business_entity=self.entity,
					business_point=self.point,
					warehouse=self.warehouse,
					status="Closed",
					source=source,
					external_id=external_id,
					opened_at=add_to_date(now_datetime(), minutes=-15),
					closed_at=add_to_date(now_datetime(), minutes=-5),
				)
				self.assertEqual(get_delete_preview("sales_shift", shift)["strategy"], "hard_delete")
				self.assertTrue(delete_entity("sales_shift", shift)["deleted"])
				self.assertFalse(frappe.db.exists("Sales Shift", shift))
				if external_id:
					self.assertTrue(is_external_event_suppressed(source, external_id))
				if source == "MoySklad":
					stats = {"duplicates": 0}
					moysklad_sales._upsert_shift({"id": external_id.rsplit(":", 1)[-1]}, {"stats": stats})
					self.assertEqual(stats["duplicates"], 1)
					self.assertFalse(frappe.db.exists("Sales Shift", {"external_id": external_id}))

	def test_employee_history_archives_but_unused_employee_is_removed(self):
		unused = self._employee()
		self.assertEqual(delete_entity("employee", unused.name)["strategy"], "hard_delete")
		self.assertFalse(frappe.db.exists("Employee", unused.name))
		used = self._employee(pos_access=1)
		leave = self._raw("Employee Leave", f"TEST-DEL-LEAVE-{uuid4().hex[:10]}", employee=used.name)
		profile = self._raw(
			"Raspechatka User Profile", f"TEST-DEL-PROFILE-{uuid4().hex[:10]}", linked_employee=used.name
		)
		frappe.db.set_value("Employee", used.name, "system_user_profile", profile)
		preview = get_delete_preview("employee", used.name)
		self.assertEqual(preview["strategy"], "deactivate")
		self.assertIn(leave, preview["dependencies"]["Employee Leave"]["names"])
		self.assertTrue(preview["warnings"])
		result = delete_entity("employee", used.name)
		self.assertEqual(result["strategy"], "deactivate")
		self.assertEqual(frappe.db.get_value("Employee", used.name, ["active", "pos_access_enabled"]), (0, 0))
		self.assertTrue(frappe.db.exists("Employee Leave", leave))
		self.assertTrue(frappe.db.exists("Raspechatka User Profile", profile))

	def test_collection_cancels_finance_transaction_and_restores_shift(self):
		article = frappe.db.get_value("Financial Article", {"article_name": "Выручка", "active": 1}, "name")
		if not article:
			self._raw(
				"Financial Article",
				f"TEST-DEL-ARTICLE-{uuid4().hex[:10]}",
				article_name="Выручка",
				article_type="Income",
				active=1,
			)
		movement = frappe.get_doc(
			{
				"doctype": "Cash Movement",
				"movement_type": "Withdrawal",
				"withdrawal_purpose": "Collection",
				"posting_datetime": now_datetime(),
				"shift": self.shift,
				"business_entity": self.entity,
				"business_point": self.point,
				"source": "POS",
				"external_id": f"POS-CASH-{uuid4().hex}",
				"amount": 50,
				"reason": "DEV-181 collection",
			}
		).insert(ignore_permissions=True)
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

		with (
			patch.object(StockReceipt, "on_cancel", fail_after_effects),
			patch.object(frappe.db, "rollback", side_effect=rollback_request),
			patch.object(frappe.db, "commit"),
		):
			with self.assertRaisesRegex(RuntimeError, "Injected failure"):
				delete_entity("stock_receipt", receipt.name)
		self.assertEqual(self._balance(), before)
		self.assertEqual(frappe.db.get_value("Stock Receipt", receipt.name, "docstatus"), 1)
		self.assertFalse(
			frappe.db.exists(
				"Stock Ledger Entry",
				{
					"voucher_type": "Stock Receipt",
					"voucher_no": receipt.name,
					"is_reversal": 1,
				},
			)
		)

	def test_unused_point_removes_only_empty_infrastructure(self):
		# Base fixture has a shift; remove it first to make the point unused.
		delete_entity("sales_shift", self.shift)
		workplace = self._raw("POS Workplace", f"WP-{uuid4().hex[:8]}", business_point=self.point, active=1)
		register = self._raw(
			"Cash Register",
			f"REG-{uuid4().hex[:8]}",
			business_point=self.point,
			pos_workplace=workplace,
			active=1,
		)
		preview = get_delete_preview("business_point", self.point)
		self.assertEqual(preview["strategy"], "hard_delete")
		self.assertEqual(delete_entity("business_point", self.point)["strategy"], "hard_delete")
		for doctype, name in (
			("Business Point", self.point),
			("Catalog Warehouse", self.warehouse),
			("POS Workplace", workplace),
			("Cash Register", register),
		):
			self.assertFalse(frappe.db.exists(doctype, name))

	def test_used_point_and_referenced_item_keep_history(self):
		self._receipt(quantity=1)
		preview = get_delete_preview("business_point", self.point)
		self.assertEqual(preview["strategy"], "deactivate")
		delete_entity("business_point", self.point)
		self.assertEqual(frappe.db.get_value("Business Point", self.point, "active"), 0)
		self.assertTrue(frappe.db.exists("Sales Shift", self.shift))
		self.assertEqual(get_delete_preview("catalog_item", self.item)["strategy"], "deactivate")

	def test_edit_user_denied_by_server_before_document_lookup(self):
		with patch("raspechatka.deletion.require_access", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				get_delete_preview("business_point", self.point)
			with self.assertRaises(frappe.PermissionError):
				delete_entity("business_point", self.point)
