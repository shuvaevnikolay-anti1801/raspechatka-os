# ruff: noqa: RUF001
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from raspechatka.api import pos as pos_api
from raspechatka.api import pos_v2
from raspechatka.raspechatka_os.doctype.purchase_order import purchase_order as purchase_order_module


class TestPosOperationalWarehouseContract(TestCase):
	def test_operational_catalog_is_independent_from_sale_assortment(self):
		def get_all(doctype, **kwargs):
			if doctype == "Stock Balance":
				self.assertEqual(kwargs["filters"]["warehouse"], "WH-A")
				return [SimpleNamespace(item="ITEM-HIDDEN", actual_qty=7)]
			if doctype == "Catalog Item Storage":
				self.assertEqual(kwargs["filters"]["warehouse"], "WH-A")
				return [SimpleNamespace(item="ITEM-HIDDEN", full_address="Шкаф 2")]
			if doctype == "Catalog Item":
				return [
					SimpleNamespace(
						name="ITEM-HIDDEN",
						item_name="Служебная бумага",
						item_code="HIDDEN",
						item_type="Product",
						stock_uom="пачка",
						track_inventory=1,
						has_variants=0,
					),
					SimpleNamespace(
						name="ITEM-TEMPLATE",
						item_name="Шаблон с вариантами",
						item_code="TPL",
						item_type="Product",
						stock_uom="шт",
						track_inventory=1,
						has_variants=1,
					),
				]
			raise AssertionError(f"Unexpected doctype: {doctype}")

		with (
			patch.object(pos_api.frappe.db, "get_value", return_value="WH-A"),
			patch.object(pos_api.frappe, "get_all", side_effect=get_all) as get_all_mock,
		):
			result = pos_api._get_operational_catalog("POINT-A")

		self.assertEqual(
			result,
			[
				{
					"id": "ITEM-HIDDEN",
					"name": "Служебная бумага",
					"itemCode": "HIDDEN",
					"itemType": "Product",
					"uom": "пачка",
					"trackInventory": True,
					"stock": 7.0,
					"storageAddress": "Шкаф 2",
				}
			],
		)
		self.assertNotIn("Catalog Assortment", [call.args[0] for call in get_all_mock.call_args_list])

	def test_open_purchase_orders_include_only_remaining_rows(self):
		def get_all(doctype, **kwargs):
			if doctype == "Purchase Order":
				self.assertEqual(kwargs["filters"]["business_point"], "POINT-A")
				return [
					SimpleNamespace(
						name="PO-1",
						supplier="SUP-1",
						expected_date="2026-09-25",
						order_status="Частично принято",
						delivery_company="СДЭК",
						delivery_code="1234",
						delivery_note="Проверить упаковку",
						remarks="Позвонить поставщику",
					)
				]
			if doctype == "Purchase Order Item":
				return [
					SimpleNamespace(
						name="POI-1",
						parent="PO-1",
						item="ITEM-1",
						item_code="I-1",
						uom="шт",
						quantity=5,
						received_quantity=2,
					),
					SimpleNamespace(
						name="POI-2",
						parent="PO-1",
						item="ITEM-2",
						item_code="I-2",
						uom="шт",
						quantity=1,
						received_quantity=1,
					),
				]
			if doctype == "Catalog Item":
				return [
					SimpleNamespace(name="ITEM-1", item_name="Бумага"),
					SimpleNamespace(name="ITEM-2", item_name="Конверт"),
				]
			raise AssertionError(f"Unexpected doctype: {doctype}")

		with patch.object(pos_api.frappe, "get_all", side_effect=get_all):
			result = pos_api._get_delivery_notices("POINT-A")

		self.assertEqual(len(result), 1)
		self.assertEqual(result[0]["receivingNote"], "Проверить упаковку")
		self.assertEqual(result[0]["comment"], "Позвонить поставщику")
		self.assertEqual(
			result[0]["items"],
			[
				{
					"purchaseOrderItemId": "POI-1",
					"itemId": "ITEM-1",
					"itemName": "Бумага",
					"itemCode": "I-1",
					"uom": "шт",
					"orderedQuantity": 5.0,
					"receivedQuantity": 2.0,
					"remainingQuantity": 3.0,
				}
			],
		)


class TestPosLocalWarehouseTruth(TestCase):
	def test_stock_receipt_queues_without_optimistically_mutating_delivery_cache(self):
		source = (
			Path(__file__).resolve().parents[2] / "pos" / "src" / "main" / "database.ts"
		).read_text(encoding="utf-8")
		method = source[source.index("  createStockReceipt("):source.index("  recordCleanerVisit(")]
		self.assertIn("this.queue('stock.receipt.requested'", method)
		self.assertNotIn("data.deliveries=", method)
		self.assertNotIn("this.setWorkplaceData(data)", method)


class TestCanonicalPurchaseOrderReceiptStatus(TestCase):
	def test_received_quantities_keep_partial_open_and_close_only_when_full(self):
		for received_quantity, expected_status in ((2, "Частично принято"), (5, "Принято")):
			with self.subTest(received_quantity=received_quantity):
				row = SimpleNamespace(name="POI-1", db_set=MagicMock())
				order = SimpleNamespace(items=[row], total_quantity=5)

				def get_all(doctype, **kwargs):
					if doctype == "Stock Receipt":
						return ["REC-1"]
					if doctype == "Stock Receipt Item":
						return [SimpleNamespace(purchase_order_item="POI-1", quantity=received_quantity)]
					raise AssertionError(f"Unexpected doctype: {doctype}")

				with (
					patch.object(purchase_order_module.frappe.db, "exists", return_value=True),
					patch.object(purchase_order_module.frappe, "get_doc", return_value=order),
					patch.object(purchase_order_module.frappe, "get_all", side_effect=get_all),
					patch.object(purchase_order_module.frappe.db, "set_value") as set_value,
				):
					purchase_order_module.update_received_quantities("PO-1")

				row.db_set.assert_called_once_with(
					"received_quantity", received_quantity, update_modified=False
				)
				set_value.assert_called_once_with(
					"Purchase Order",
					"PO-1",
					{"received_quantity": received_quantity, "order_status": expected_status},
					update_modified=False,
				)


class TestPosWarehouseIngestion(TestCase):
	def test_receipt_uses_only_server_owned_purchase_order_data(self):
		order = SimpleNamespace(
			name="PO-1",
			docstatus=1,
			business_entity="BE-1",
			business_point="POINT-A",
			warehouse="WH-A",
			supplier="SUP-1",
			order_status="Ожидается",
		)
		order_row = SimpleNamespace(
			name="POI-1",
			item="ITEM-1",
			item_code="I-1",
			uom="пачка",
			quantity=5,
			received_quantity=1,
			rate=123.45,
		)
		doc = MagicMock()

		def get_value(doctype, name_or_filters, fieldname, **kwargs):
			if doctype == "Purchase Order":
				return order
			if doctype == "Catalog Item Storage":
				return "LOC-1"
			raise AssertionError(f"Unexpected get_value: {doctype}")

		with (
			patch.object(pos_v2.frappe.db, "exists", return_value=False),
			patch.object(pos_v2.frappe.db, "sql", return_value=[("PO-1",)]),
			patch.object(pos_v2.frappe.db, "get_value", side_effect=get_value),
			patch.object(pos_v2.frappe, "get_all", return_value=[order_row]),
			patch.object(pos_v2, "get_item", return_value=SimpleNamespace(item_name="Бумага")),
			patch.object(pos_v2.frappe, "get_doc", return_value=doc) as get_doc,
		):
			pos_v2._ingest_stock_receipt(
				"EVENT-1",
				{
					"purchaseOrderId": "PO-1",
					"lines": [
						{
							"purchaseOrderItemId": "POI-1",
							"quantity": 2,
							"rate": 999999,
							"itemId": "ATTACKER-ITEM",
						}
					],
					"supplier": "ATTACKER-SUPPLIER",
					"warehouse": "ATTACKER-WH",
				},
				SimpleNamespace(business_point="POINT-A"),
				"EMP-1",
			)

		values = get_doc.call_args.args[0]
		self.assertEqual(values["business_entity"], "BE-1")
		self.assertEqual(values["business_point"], "POINT-A")
		self.assertEqual(values["warehouse"], "WH-A")
		self.assertEqual(values["supplier"], "SUP-1")
		self.assertEqual(values["cashier"], "EMP-1")
		self.assertEqual(values["source"], "POS")
		self.assertEqual(values["external_id"], "EVENT-1")
		self.assertEqual(
			values["items"],
			[
				{
					"item": "ITEM-1",
					"uom": "пачка",
					"quantity": 2.0,
					"rate": 123.45,
					"purchase_order_item": "POI-1",
					"storage_location": "LOC-1",
				}
			],
		)
		doc.insert.assert_called_once_with(ignore_permissions=True)
		doc.submit.assert_called_once_with()

	def test_foreign_purchase_order_is_rejected_by_point_lock(self):
		with (
			patch.object(pos_v2.frappe.db, "exists", return_value=False),
			patch.object(pos_v2.frappe.db, "sql", return_value=[]) as sql,
		):
			with self.assertRaises(Exception):
				pos_v2._ingest_stock_receipt(
					"EVENT-FOREIGN",
					{
						"purchaseOrderId": "PO-FOREIGN",
						"lines": [{"purchaseOrderItemId": "POI-X", "quantity": 1}],
					},
					SimpleNamespace(business_point="POINT-A"),
					"EMP-1",
				)
		self.assertEqual(sql.call_args.args[1], ("PO-FOREIGN", "POINT-A"))

	def test_write_off_rejects_item_without_balance_in_point_warehouse(self):
		def exists(doctype, filters):
			if doctype == "Stock Write Off":
				return False
			if doctype == "Stock Balance":
				self.assertEqual(filters, {"item": "ITEM-FOREIGN", "warehouse": "WH-A"})
				return False
			raise AssertionError(f"Unexpected exists lookup: {doctype}")

		with (
			patch.object(pos_v2.frappe.db, "exists", side_effect=exists),
			patch.object(
				pos_v2,
				"_point_stock_context",
				return_value=(SimpleNamespace(name="POINT-A", business_entity="BE-1"), "WH-A"),
			),
			patch.object(pos_v2, "get_item"),
			patch.object(pos_v2.frappe, "get_doc") as get_doc,
		):
			with self.assertRaises(Exception):
				pos_v2._ingest_stock_write_off(
					"EVENT-FOREIGN",
					{"productId": "ITEM-FOREIGN", "quantity": 1},
					SimpleNamespace(business_point="POINT-A"),
					"EMP-1",
				)
		get_doc.assert_not_called()

	def test_duplicate_warehouse_events_are_noops(self):
		with (
			patch.object(pos_v2.frappe.db, "exists", return_value=True),
			patch.object(pos_v2.frappe, "get_doc") as get_doc,
		):
			pos_v2._ingest_stock_write_off(
				"EVENT-WO",
				{"productId": "ITEM-1", "quantity": 1},
				SimpleNamespace(business_point="POINT-A"),
				"EMP-1",
			)
			pos_v2._ingest_supply_request(
				"EVENT-NEED",
				{"itemName": "Бумага", "quantity": 1},
				SimpleNamespace(business_point="POINT-A"),
				"EMP-1",
			)
			pos_v2._ingest_stock_receipt(
				"EVENT-REC",
				{"purchaseOrderId": "PO-1", "lines": [{"purchaseOrderItemId": "POI-1", "quantity": 1}]},
				SimpleNamespace(business_point="POINT-A"),
				"EMP-1",
			)
		get_doc.assert_not_called()

	def test_push_events_routes_and_accepts_all_warehouse_event_types(self):
		connection = SimpleNamespace(business_point="POINT-A", app_version=None, last_sync_at=None)
		events = [
			{
				"id": "EVENT-WO",
				"eventType": "stock.write_off.requested",
				"payload": {"cashierId": "EMP-1", "productId": "ITEM-1", "quantity": 1},
			},
			{
				"id": "EVENT-NEED",
				"eventType": "point.supply.requested",
				"payload": {"cashierId": "EMP-1", "itemName": "Бумага", "quantity": 2},
			},
			{
				"id": "EVENT-REC",
				"eventType": "stock.receipt.requested",
				"payload": {
					"cashierId": "EMP-1",
					"purchaseOrderId": "PO-1",
					"lines": [{"purchaseOrderItemId": "POI-1", "quantity": 1}],
				},
			},
		]
		with (
			patch.object(pos_v2.base_pos, "_authenticate", return_value=connection),
			patch.object(pos_v2.base_pos, "_point_employees", return_value=[{"id": "EMP-1", "name": "Иван"}]),
			patch.object(pos_v2, "_trusted_event_cashier", return_value={"id": "EMP-1"}),
			patch.object(pos_v2.frappe.db, "savepoint"),
			patch.object(pos_v2.frappe.db, "rollback"),
			patch.object(pos_v2, "_ingest_stock_write_off") as write_off,
			patch.object(pos_v2, "_ingest_supply_request") as supply,
			patch.object(pos_v2, "_ingest_stock_receipt") as receipt,
			patch.object(pos_v2.base_pos, "_touch"),
		):
			result = pos_v2.push_events("DEVICE-1", "TOKEN", events=events, app_version="test")

		self.assertEqual(result["accepted"], ["EVENT-WO", "EVENT-NEED", "EVENT-REC"])
		self.assertEqual(result["errors"], [])
		write_off.assert_called_once()
		supply.assert_called_once()
		receipt.assert_called_once()
