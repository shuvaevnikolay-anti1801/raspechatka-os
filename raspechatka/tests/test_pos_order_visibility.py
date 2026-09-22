from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from raspechatka.api import pos, pos_device, pos_v2, sales


class Row(dict):
	def __getattr__(self, name):
		return self.get(name)

	def __setattr__(self, name, value):
		self[name] = value


class CanonicalStore:
	def __init__(self):
		self.orders = {}
		self.points = {
			"POINT-1": Row(name="POINT-1", point_name="Первая", business_entity="ENTITY-1", city="Ярославль"),
			"POINT-2": Row(name="POINT-2", point_name="Чужая", business_entity="ENTITY-2", city="Москва"),
		}
		self.db = SimpleNamespace(exists=self.exists, get_value=self.get_value)

	def exists(self, doctype, filters):
		if doctype == "DocType":
			return filters == "POS Order"
		if doctype == "Catalog Item":
			return False
		if doctype == "POS Order":
			return any(
				all(order.get(key) == value for key, value in filters.items())
				for order in self.orders.values()
			)
		return False

	def get_value(self, doctype, filters, field, **kwargs):
		if doctype == "Sales Shift":
			return None
		if doctype == "Sales Receipt":
			if filters.get("business_point") == "POINT-1" and filters.get("receipt_type") == "Sale":
				if filters.get("external_id") == "SALE-1" or filters.get("name") == "RECEIPT-1":
					return "RECEIPT-1"
			return None
		if doctype == "POS Order":
			for name, order in self.orders.items():
				if all(order.get(key) == value for key, value in filters.items()):
					return name
			return None
		return None

	def get_doc(self, doctype, name=None):
		if isinstance(doctype, dict):
			store = self

			class OrderDocument(Row):
				def insert(self, ignore_permissions=False):
					self.name = self.get("name") or "POS-ORDER-1"
					self.creation = self.get("created_at") or "2026-09-20T09:00:00.000Z"
					store.orders[self.name] = self
					return self

				def save(self, ignore_permissions=False):
					store.orders[self.name] = self
					return self

			return OrderDocument(doctype)
		if doctype == "POS Order":
			return self.orders[name]
		raise AssertionError(f"Unexpected get_doc: {doctype}")

	def get_all(self, doctype, filters=None, fields=None, pluck=None, **kwargs):
		filters = filters or {}
		if doctype == "Business Point":
			rows = list(self.points.values())
			names = filters.get("name")
			if isinstance(names, list) and names[0] == "in":
				rows = [row for row in rows if row.name in names[1]]
			entity = filters.get("business_entity")
			if isinstance(entity, list) and entity[0] == "in":
				rows = [row for row in rows if row.business_entity in entity[1]]
			elif isinstance(entity, str):
				rows = [row for row in rows if row.business_entity == entity]
			return [row.name for row in rows] if pluck == "name" else rows
		if doctype == "POS Order":
			rows = list(self.orders.values())
			points = filters.get("business_point")
			if isinstance(points, list) and points[0] == "in":
				rows = [row for row in rows if row.business_point in points[1]]
			elif isinstance(points, str):
				rows = [row for row in rows if row.business_point == points]
			if filters.get("status"):
				rows = [row for row in rows if row.status == filters["status"]]
			return rows
		if doctype == "POS Order Item":
			parents = filters["parent"][1]
			return [
				Row(
					parent=order.name,
					item=item.get("item"),
					item_name=item.get("item_name"),
					quantity=item.get("quantity"),
					rate=item.get("rate"),
				)
				for order in self.orders.values()
				if order.name in parents
				for item in order.get("items", [])
			]
		raise AssertionError(f"Unexpected get_all: {doctype}")


class TestPosOrderVisibility(TestCase):
	def test_pos_events_are_visible_in_scoped_web_orders_and_bootstrap(self):
		store = CanonicalStore()
		connection = Row(name="POS-CONNECTION-1", business_point="POINT-1", app_version=None)
		created = {
			"orderNumber": "ORD-20260920-ABC123",
			"phone": "+7 900 123-45-67",
			"comment": "Печать фотокниги",
			"status": "in_progress",
			"createdAt": "2026-09-20T09:00:00.000Z",
			"dueAt": "2026-09-20T12:00:00.000Z",
			"sourceSaleId": "SALE-1",
			"fiscalNumber": "777",
			"totalMinor": 12345,
			"paidMinor": 12345,
			"cashierId": "EMP-1",
			"lines": [{"productId": "PRINT-1", "name": "Фотокнига", "quantity": 1, "unitPriceMinor": 12345}],
		}
		ready = {
			**created,
			"status": "ready",
			"readyAt": "2026-09-20T10:30:00.000Z",
		}
		events = [
			{"id": "EVENT-CREATE-1", "eventType": "order.created", "payload": created},
			{"id": "EVENT-READY-1", "eventType": "order.updated", "payload": ready},
		]

		with (
			patch.object(pos, "frappe", store),
			patch.object(pos, "_doctype_exists", return_value=True),
			patch.object(pos_v2.base_pos, "_authenticate", return_value=connection),
			patch.object(pos_v2.base_pos, "_point_employees", return_value=[{"id": "EMP-1", "name": "Кассир"}]),
			patch.object(pos_v2, "_trusted_event_cashier", return_value={"id": "EMP-1", "name": "Кассир"}),
			patch.object(pos_v2, "_normalize_v2_payload", side_effect=lambda payload: payload),
			patch.object(pos_v2.base_pos, "_touch"),
		):
			result = pos_v2.push_events("DEVICE-1", "TOKEN-1", events=events, app_version="test")

		self.assertEqual(result["accepted"], ["EVENT-CREATE-1", "EVENT-READY-1"])
		order = store.orders["POS-ORDER-1"]
		self.assertEqual(order.business_point, "POINT-1")
		self.assertEqual(order.status, "Ready")
		self.assertEqual(order.ready_at, "2026-09-20T10:30:00.000Z")
		self.assertEqual(order.source_receipt, "RECEIPT-1")

		current_scope = {"global": False, "points": ["POINT-1"]}
		with (
			patch.object(sales, "frappe", store),
			patch.object(sales, "require_access") as require_access,
			patch.object(sales, "get_scope", return_value=current_scope),
			patch.object(sales, "get_allowed_entities", return_value=["ENTITY-1"]),
		):
			rows = sales.get_orders()["rows"]

		require_access.assert_called_once_with("page.sales.orders", "read")
		self.assertEqual(len(rows), 1)
		self.assertEqual(
			rows[0],
			{
				"name": "POS-ORDER-1",
				"short_number": "№ 4567",
				"order_number": "ORD-20260920-ABC123",
				"phone": "+7 900 123-45-67",
				"business_point": "POINT-1",
				"comment": "Печать фотокниги",
				"fiscal_number": "777",
				"source_receipt": "RECEIPT-1",
				"total_amount": 123.45,
				"paid_amount": 123.45,
				"status": "Ready",
				"created_at": "2026-09-20T09:00:00.000Z",
				"due_at": "2026-09-20T12:00:00.000Z",
				"ready_at": "2026-09-20T10:30:00.000Z",
				"issued_at": None,
				"execution_minutes": 90,
				"overdue": False,
			},
		)

		with (
			patch.object(pos, "frappe", store),
			patch.object(pos, "_doctype_exists", return_value=True),
			patch.object(pos, "_pos_datetime_to_utc", side_effect=lambda value: str(value) if value else None),
		):
			bootstrap_orders = pos._get_orders("POINT-1")

		self.assertEqual(len(bootstrap_orders), 1)
		self.assertEqual(
			bootstrap_orders[0],
			{
				"id": "POS-ORDER-1",
				"orderNumber": "ORD-20260920-ABC123",
				"phone": "+7 900 123-45-67",
				"customerName": None,
				"lines": [{"productId": None, "name": "Фотокнига", "quantity": 1.0, "unitPriceMinor": 12345}],
				"totalMinor": 12345,
				"paidMinor": 12345,
				"paymentStatus": "paid",
				"status": "ready",
				"comment": "Печать фотокниги",
				"createdAt": "2026-09-20T09:00:00.000Z",
				"dueAt": "2026-09-20T12:00:00.000Z",
				"readyAt": "2026-09-20T10:30:00.000Z",
				"issuedAt": None,
				"sourceSaleId": "SALE-1",
				"fiscalNumber": "777",
				"sourceReceipt": "RECEIPT-1",
			},
		)

	def test_foreign_point_cannot_see_or_modify_order(self):
		store = CanonicalStore()
		order = Row(
			name="POS-ORDER-1",
			order_number="ORD-1",
			phone="+79001234567",
			business_point="POINT-1",
			comment="Исходное описание",
			total_amount=100,
			paid_amount=100,
			status="In Progress",
			created_at="2026-09-20T09:00:00.000Z",
			creation="2026-09-20T09:00:00.000Z",
			due_at=None,
			ready_at=None,
			issued_at=None,
			source_sale_id=None,
			source_receipt=None,
			fiscal_number=None,
			items=[],
		)
		store.orders[order.name] = order

		with (
			patch.object(pos, "frappe", store),
			patch.object(pos, "_doctype_exists", return_value=True),
		):
			pos_device._ingest_order(
				"order.updated",
				"EVENT-FOREIGN-UPDATE",
				Row(name="POS-CONNECTION-2", business_point="POINT-2"),
				{"orderNumber": "ORD-1", "comment": "Подменено", "status": "ready"},
			)

		self.assertEqual(order.comment, "Исходное описание")
		self.assertEqual(order.status, "In Progress")

		foreign_scope = {"global": False, "points": ["POINT-2"]}
		with (
			patch.object(sales, "frappe", store),
			patch.object(sales, "require_access"),
			patch.object(sales, "get_scope", return_value=foreign_scope),
			patch.object(sales, "get_allowed_entities", return_value=["ENTITY-2"]),
		):
			self.assertEqual(sales.get_orders(), {"rows": []})
