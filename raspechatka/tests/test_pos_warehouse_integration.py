from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_to_date, now_datetime

from raspechatka.api import pos_v2
from raspechatka.api import sales as sales_ingest


class TestPosWarehouseRoundTrip(FrappeTestCase):
	def setUp(self):
		super().setUp()
		suffix = uuid4().hex[:10]
		self.entity = self._raw("Business Entity", f"TEST-BE-{suffix}")
		self.point = self._raw(
			"Business Point",
			f"TEST-POINT-{suffix}",
			business_entity=self.entity,
			active=1,
		)
		self.foreign_point = self._raw(
			"Business Point",
			f"TEST-POINT-FOREIGN-{suffix}",
			business_entity=self.entity,
			active=1,
		)
		self.warehouse = self._raw(
			"Catalog Warehouse",
			f"TEST-WH-{suffix}",
			business_point=self.point,
			active=1,
		)
		self.foreign_warehouse = self._raw(
			"Catalog Warehouse",
			f"TEST-WH-FOREIGN-{suffix}",
			business_point=self.foreign_point,
			active=1,
		)
		self.supplier = self._raw("Catalog Supplier", f"TEST-SUP-{suffix}", active=1)
		self.uom = self._raw("Catalog Unit", f"TEST-UOM-{suffix}")
		self.employee = self._raw(
			"Employee",
			f"TEST-EMP-{suffix}",
			business_point=self.point,
		)
		self.item = self._raw(
			"Catalog Item",
			f"TEST-ITEM-{suffix}",
			item_name="Тестовая бумага",
			item_code=f"TEST-ITEM-{suffix}",
			item_type="Product",
			stock_uom=self.uom,
			track_inventory=1,
			active=1,
			has_variants=0,
		)
		self.foreign_item = self._raw(
			"Catalog Item",
			f"TEST-ITEM-FOREIGN-{suffix}",
			item_name="Чужой складской товар",
			item_code=f"TEST-ITEM-FOREIGN-{suffix}",
			item_type="Product",
			stock_uom=self.uom,
			track_inventory=1,
			active=1,
			has_variants=0,
		)

	def _raw(self, doctype, name, **values):
		doc = frappe.get_doc({"doctype": doctype, "name": name, **values})
		doc.db_insert()
		return doc.name

	def _purchase_order(self, point=None, warehouse=None, quantity=4, rate=125):
		doc = frappe.get_doc(
			{
				"doctype": "Purchase Order",
				"business_entity": self.entity,
				"business_point": point or self.point,
				"warehouse": warehouse or self.warehouse,
				"supplier": self.supplier,
				"items": [{"item": self.item, "quantity": quantity, "rate": rate}],
			}
		)
		doc.insert(ignore_permissions=True)
		doc.submit()
		return doc

	def _opening_stock(self, item, warehouse, point, quantity=5, rate=100):
		doc = frappe.get_doc(
			{
				"doctype": "Stock Receipt",
				"receipt_type": "Оприходование",
				"posting_datetime": add_to_date(now_datetime(), seconds=-30),
				"business_entity": self.entity,
				"business_point": point,
				"warehouse": warehouse,
				"reason": "Интеграционный тест",
				"source": "Manual",
				"items": [{"item": item, "quantity": quantity, "rate": rate}],
			}
		)
		doc.flags.ignore_stock_chronology = True
		doc.insert(ignore_permissions=True)
		doc.flags.ignore_stock_chronology = True
		doc.submit()
		return doc

	def _push(self, event):
		connection = SimpleNamespace(
			business_point=self.point,
			app_version=None,
			last_sync_at=None,
		)
		with (
			patch.object(pos_v2.base_pos, "_authenticate", return_value=connection),
			patch.object(
				pos_v2.base_pos,
				"_point_employees",
				return_value=[{"id": self.employee, "name": "Тестовый кассир"}],
			),
			patch.object(pos_v2.base_pos, "_touch"),
		):
			return pos_v2.push_events("TEST-DEVICE", "TEST-TOKEN", events=[event], app_version="test")

	def _balance(self, item, warehouse):
		return float(
			frappe.db.get_value(
				"Stock Balance",
				{"item": item, "warehouse": warehouse},
				"actual_qty",
			)
			or 0
		)

	def test_cross_point_duplicate_ids_are_rejected_for_money_stock_and_requests(self):
		foreign_connection = SimpleNamespace(business_point=self.foreign_point)
		local_connection = SimpleNamespace(business_point=self.point)
		cases = (
			("Sales Receipt", "external_id", sales_ingest._ingest_receipt, True),
			("Cash Movement", "external_id", sales_ingest._ingest_cash, True),
			("Stock Receipt", "external_id", pos_v2._ingest_stock_receipt, True),
			("Stock Write Off", "external_id", pos_v2._ingest_stock_write_off, True),
			("Point Supply Request", "source_pos_event", pos_v2._ingest_supply_request, False),
		)
		for doctype, field, ingest, submitted in cases:
			with self.subTest(doctype=doctype):
				event_id = f"DEV177-{doctype.replace(' ', '-')}-{uuid4().hex}"
				self._raw(doctype, f"RAW-{uuid4().hex}", **{
					field: event_id, "business_point": self.point,
					**({"docstatus": 1} if submitted else {}),
				})
				with self.assertRaises(frappe.PermissionError):
					if doctype in ("Sales Receipt", "Cash Movement"):
						ingest({"external_id": event_id}, foreign_connection,
							{"created": 0, "duplicates": 0, "errors": []})
					else:
						ingest(event_id, {}, foreign_connection, self.employee)
				if doctype in ("Sales Receipt", "Cash Movement"):
					stats = {"created": 0, "duplicates": 0, "errors": []}
					ingest({"external_id": event_id}, local_connection, stats)
					self.assertEqual(stats["duplicates"], 1)
				else:
					ingest(event_id, {}, local_connection, self.employee)

	def test_cleaner_visit_replay_is_serialized_and_cross_point_key_is_denied(self):
		event_id = f"VISIT-{uuid4().hex}"
		self._raw("Cleaner Visit", f"RAW-VISIT-{uuid4().hex}",
			business_point=self.point, visit_date="2026-09-23", source_pos_event=event_id)
		created_at = "2026-09-23T09:00:00+03:00"
		pos_v2._ingest_cleaner_visit(event_id, {}, SimpleNamespace(business_point=self.point),
			self.employee, created_at)
		self.assertEqual(frappe.db.count("Cleaner Visit", {"source_pos_event": event_id}), 1)
		with self.assertRaises(frappe.PermissionError):
			pos_v2._ingest_cleaner_visit(event_id, {},
				SimpleNamespace(business_point=self.foreign_point), self.employee, created_at)

	def test_real_purchase_order_receipt_partial_full_replay_and_foreign_rejection(self):
		order = self._purchase_order()
		row = order.items[0]
		event = {
			"id": f"POS-REC-{uuid4().hex}",
			"eventType": "stock.receipt.requested",
			"payload": {
				"cashierId": self.employee,
				"purchaseOrderId": order.name,
				"lines": [{"purchaseOrderItemId": row.name, "quantity": 2}],
				"supplier": "FORGED",
				"warehouse": "FORGED",
				"rate": 999999,
			},
		}
		result = self._push(event)
		self.assertEqual(result, {"accepted": [event["id"]], "errors": []})

		receipt = frappe.get_last_doc("Stock Receipt", filters={"external_id": event["id"]})
		self.assertEqual(receipt.docstatus, 1)
		self.assertEqual(receipt.source, "POS")
		self.assertEqual(receipt.external_id, event["id"])
		self.assertEqual(receipt.cashier, self.employee)
		self.assertEqual(receipt.purchase_order, order.name)
		self.assertEqual(receipt.supplier, self.supplier)
		self.assertEqual(receipt.warehouse, self.warehouse)
		self.assertEqual(receipt.items[0].purchase_order_item, row.name)
		self.assertEqual(receipt.items[0].item, self.item)
		self.assertEqual(float(receipt.items[0].quantity), 2)
		self.assertEqual(float(receipt.items[0].rate), 125)

		order.reload()
		self.assertEqual(float(order.items[0].received_quantity), 2)
		self.assertEqual(order.order_status, "Частично принято")
		balance_after_first = self._balance(self.item, self.warehouse)

		replay = self._push(event)
		self.assertEqual(replay, {"accepted": [event["id"]], "errors": []})
		self.assertEqual(frappe.db.count("Stock Receipt", {"external_id": event["id"]}), 1)
		self.assertEqual(self._balance(self.item, self.warehouse), balance_after_first)

		full_event = {
			"id": f"POS-REC-{uuid4().hex}",
			"eventType": "stock.receipt.requested",
			"payload": {
				"cashierId": self.employee,
				"purchaseOrderId": order.name,
				"lines": [{"purchaseOrderItemId": row.name, "quantity": 2}],
			},
		}
		self.assertEqual(self._push(full_event), {"accepted": [full_event["id"]], "errors": []})
		order.reload()
		self.assertEqual(float(order.items[0].received_quantity), 4)
		self.assertEqual(order.order_status, "Принято")

		foreign_order = self._purchase_order(
			point=self.foreign_point,
			warehouse=self.foreign_warehouse,
			quantity=1,
		)
		foreign_event = {
			"id": f"POS-REC-FOREIGN-{uuid4().hex}",
			"eventType": "stock.receipt.requested",
			"payload": {
				"cashierId": self.employee,
				"purchaseOrderId": foreign_order.name,
				"lines": [
					{"purchaseOrderItemId": foreign_order.items[0].name, "quantity": 1}
				],
			},
		}
		foreign_result = self._push(foreign_event)
		self.assertEqual(foreign_result["accepted"], [])
		self.assertEqual(foreign_result["errors"][0]["id"], foreign_event["id"])
		self.assertIn("недоступен для этой точки", foreign_result["errors"][0]["message"])
		self.assertFalse(frappe.db.exists("Stock Receipt", {"external_id": foreign_event["id"]}))

	def test_real_write_off_has_one_stock_effect_and_rejects_foreign_context(self):
		self._opening_stock(self.item, self.warehouse, self.point)
		self._opening_stock(
			self.foreign_item,
			self.foreign_warehouse,
			self.foreign_point,
		)
		before = self._balance(self.item, self.warehouse)
		event = {
			"id": f"POS-WO-{uuid4().hex}",
			"eventType": "stock.write_off.requested",
			"payload": {
				"cashierId": self.employee,
				"productId": self.item,
				"quantity": 2,
				"reason": "Внутренние нужды",
				"comment": "Интеграционный тест POS",
			},
		}
		self.assertEqual(self._push(event), {"accepted": [event["id"]], "errors": []})
		write_off = frappe.get_last_doc("Stock Write Off", filters={"external_id": event["id"]})
		self.assertEqual(write_off.docstatus, 1)
		self.assertEqual(write_off.source, "POS")
		self.assertEqual(write_off.external_id, event["id"])
		self.assertEqual(write_off.cashier, self.employee)
		self.assertEqual(write_off.business_point, self.point)
		self.assertEqual(write_off.warehouse, self.warehouse)
		self.assertEqual(write_off.items[0].item, self.item)
		self.assertEqual(float(write_off.items[0].quantity), 2)
		self.assertEqual(self._balance(self.item, self.warehouse), before - 2)

		after = self._balance(self.item, self.warehouse)
		self.assertEqual(self._push(event), {"accepted": [event["id"]], "errors": []})
		self.assertEqual(frappe.db.count("Stock Write Off", {"external_id": event["id"]}), 1)
		self.assertEqual(self._balance(self.item, self.warehouse), after)

		foreign_event = {
			"id": f"POS-WO-FOREIGN-{uuid4().hex}",
			"eventType": "stock.write_off.requested",
			"payload": {
				"cashierId": self.employee,
				"productId": self.foreign_item,
				"quantity": 1,
				"reason": "Брак",
				"comment": "Попытка списать чужой остаток",
			},
		}
		foreign_result = self._push(foreign_event)
		self.assertEqual(foreign_result["accepted"], [])
		self.assertEqual(foreign_result["errors"][0]["id"], foreign_event["id"])
		self.assertIn("складского контекста этой точки", foreign_result["errors"][0]["message"])
		self.assertFalse(frappe.db.exists("Stock Write Off", {"external_id": foreign_event["id"]}))


	def test_real_write_off_rejects_invalid_reason_empty_comment_and_foreign_cashier(self):
		self._opening_stock(self.item, self.warehouse, self.point)
		cases = [
			(
				"invalid-reason",
				{
					"cashierId": self.employee,
					"productId": self.item,
					"quantity": 1,
					"reason": "Другое",
					"comment": "Комментарий есть",
				},
				"Недопустимая причина списания",
			),
			(
				"empty-comment",
				{
					"cashierId": self.employee,
					"productId": self.item,
					"quantity": 1,
					"reason": "Брак",
					"comment": "   ",
				},
				"Комментарий обязателен",
			),
			(
				"foreign-cashier",
				{
					"cashierId": f"FOREIGN-EMP-{uuid4().hex[:8]}",
					"productId": self.item,
					"quantity": 1,
					"reason": "Обучение",
					"comment": "Проверка кассира",
				},
				None,
			),
		]
		for suffix, payload, message in cases:
			with self.subTest(case=suffix):
				event = {
					"id": f"POS-WO-REJECT-{suffix}-{uuid4().hex}",
					"eventType": "stock.write_off.requested",
					"payload": payload,
				}
				result = self._push(event)
				self.assertEqual(result["accepted"], [])
				self.assertEqual(result["errors"][0]["id"], event["id"])
				if message:
					self.assertIn(message, result["errors"][0]["message"])
				self.assertFalse(frappe.db.exists("Stock Write Off", {"external_id": event["id"]}))

	def test_real_quantity_less_supply_request_maps_canonical_employee_item_comment_and_replays_once(self):
		event = {
			"id": f"POS-NEED-{uuid4().hex}",
			"eventType": "point.supply.requested",
			"payload": {
				"cashierId": self.employee,
				"productId": self.item,
				"itemName": "Подменённое название",
				"comment": "Нужен запас бумаги к выходным",
			},
		}
		self.assertNotIn("quantity", event["payload"])
		self.assertEqual(self._push(event), {"accepted": [event["id"]], "errors": []})

		request = frappe.get_last_doc(
			"Point Supply Request", filters={"source_pos_event": event["id"]}
		)
		self.assertEqual(request.business_entity, self.entity)
		self.assertEqual(request.business_point, self.point)
		self.assertEqual(request.warehouse, self.warehouse)
		self.assertEqual(request.requested_by_employee, self.employee)
		self.assertEqual(request.item, self.item)
		self.assertEqual(request.item_name, "Тестовая бумага")
		self.assertEqual(float(request.quantity), 1)
		self.assertEqual(request.comment, "Нужен запас бумаги к выходным")

		self.assertEqual(self._push(event), {"accepted": [event["id"]], "errors": []})
		self.assertEqual(
			frappe.db.count("Point Supply Request", {"source_pos_event": event["id"]}), 1
		)

		forged_quantity = {
			"id": f"POS-NEED-FORGED-QTY-{uuid4().hex}",
			"eventType": "point.supply.requested",
			"payload": {
				"cashierId": self.employee,
				"productId": self.item,
				"itemName": "Подмена",
				"quantity": 999,
				"comment": "Проверка server-owned quantity",
			},
		}
		self.assertEqual(
			self._push(forged_quantity),
			{"accepted": [forged_quantity["id"]], "errors": []},
		)
		forged_request = frappe.get_last_doc(
			"Point Supply Request", filters={"source_pos_event": forged_quantity["id"]}
		)
		self.assertEqual(float(forged_request.quantity), 1)

		empty_comment = {
			"id": f"POS-NEED-EMPTY-{uuid4().hex}",
			"eventType": "point.supply.requested",
			"payload": {
				"cashierId": self.employee,
				"productId": self.item,
				"comment": " ",
			},
		}
		result = self._push(empty_comment)
		self.assertEqual(result["accepted"], [])
		self.assertIn("Комментарий обязателен", result["errors"][0]["message"])
		self.assertFalse(
			frappe.db.exists("Point Supply Request", {"source_pos_event": empty_comment["id"]})
		)
