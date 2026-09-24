from types import SimpleNamespace
from unittest import SkipTest, TestCase
from unittest.mock import patch
from uuid import uuid4

import frappe

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
		self.db = SimpleNamespace(exists=self.exists, get_value=self.get_value, sql=self.sql)

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

	def sql(self, query, values=None, **kwargs):
		if "tabBusiness Point" in query and "for update" in query:
			return [(values,)]
		if "customer_order_number from `tabPOS Order`" in query:
			point = values
			return [
				(order.get("customer_order_number"),)
				for order in self.orders.values()
				if order.get("business_point") == point
				and order.get("status") in ("New", "In Progress", "Ready")
				and order.get("customer_order_number")
			]
		raise AssertionError(f"Unexpected sql: {query}")

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
					return order.get(field) if field != "name" else name
			return None
		return None

	def throw(self, message, exception=None):
		raise (exception or RuntimeError)(message)

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
			"contactMethod": "Telegram @client",
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
			"contactMethod": "WhatsApp",
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
			patch.object(
				pos_v2.base_pos, "_point_employees", return_value=[{"id": "EMP-1", "name": "Кассир"}]
			),
			patch.object(pos_v2, "_trusted_event_cashier", return_value={"id": "EMP-1", "name": "Кассир"}),
			patch.object(pos_v2, "_normalize_v2_payload", side_effect=lambda payload: payload),
			patch.object(pos_v2.base_pos, "_touch"),
		):
			result = pos_v2.push_events("DEVICE-1", "TOKEN-1", events=events, app_version="test")

		self.assertEqual(result["accepted"], ["EVENT-CREATE-1", "EVENT-READY-1"])
		order = store.orders["POS-ORDER-1"]
		self.assertEqual(order.business_point, "POINT-1")
		self.assertEqual(order.contact_method, "WhatsApp")
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
				"contact_method": "WhatsApp",
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
			patch.object(
				pos, "_pos_datetime_to_utc", side_effect=lambda value: str(value) if value else None
			),
		):
			bootstrap_orders = pos._get_orders("POINT-1")

		self.assertEqual(len(bootstrap_orders), 1)
		self.assertEqual(
			bootstrap_orders[0],
			{
				"id": "POS-ORDER-1",
				"orderNumber": "ORD-20260920-ABC123",
				"customerOrderNumber": "4567",
				"phone": "+7 900 123-45-67",
				"contactMethod": "WhatsApp",
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
			contact_method="Telegram",
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
			with self.assertRaisesRegex(RuntimeError, "ORD-1"):
				pos_device._ingest_order(
					"order.updated",
					"EVENT-FOREIGN-UPDATE",
					Row(name="POS-CONNECTION-2", business_point="POINT-2"),
					{
						"orderNumber": "ORD-1",
						"contactMethod": "Email",
						"comment": "Подменено",
						"status": "ready",
					},
				)

		self.assertEqual(order.contact_method, "Telegram")
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


class TestPosOrderFrappeIntegration(TestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		try:
			frappe.db.sql("select 1")
			frappe.get_meta("POS Order")
		except Exception as exc:
			raise SkipTest("Frappe site database is not initialized for integration tests") from exc

	def setUp(self):
		self.suffix = uuid4().hex[:10]
		self.save_point = f"dev168_order_{self.suffix}"
		frappe.db.savepoint(self.save_point)
		self._create_fixtures()

	def tearDown(self):
		frappe.db.rollback(save_point=self.save_point)

	@staticmethod
	def _valid_inn(seed):
		base = f"{int(seed, 16) % 10_000_000_000:010d}"
		digits = [int(value) for value in base]
		check_11 = (
			sum(weight * value for weight, value in zip((7, 2, 4, 10, 3, 5, 9, 4, 6, 8), digits, strict=True))
			% 11
			% 10
		)
		digits.append(check_11)
		check_12 = (
			sum(
				weight * value
				for weight, value in zip((3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8), digits, strict=True)
			)
			% 11
			% 10
		)
		return "".join(str(value) for value in (*digits, check_12))

	def _create_fixtures(self):
		self.organization = frappe.get_doc(
			{
				"doctype": "Organization",
				"organization_code": f"DEV168-{self.suffix}",
				"organization_name": f"DEV-168 {self.suffix}",
				"organization_type": "Franchisee",
				"active": 1,
			}
		).insert(ignore_permissions=True)
		self.entity = frappe.get_doc(
			{
				"doctype": "Business Entity",
				"short_name": f"DEV168-{self.suffix}",
				"full_name": f"ИП DEV-168 {self.suffix}",
				"organization": self.organization.name,
				"last_name": "Тестов",
				"first_name": "Заказ",
				"inn": self._valid_inn(self.suffix),
				"tax_system": "Патент",
			}
		).insert(ignore_permissions=True)
		self.position = frappe.get_doc(
			{
				"doctype": "Position",
				"position_name": f"DEV-168 кассир {self.suffix}",
				"active": 1,
			}
		).insert(ignore_permissions=True)
		self.point = frappe.get_doc(
			{
				"doctype": "Business Point",
				"point_name": f"DEV-168 point {self.suffix}",
				"business_entity": self.entity.name,
				"city": "Ярославль",
				"address": "Integration test",
				"active": 1,
			}
		).insert(ignore_permissions=True)
		self.foreign_point = frappe.get_doc(
			{
				"doctype": "Business Point",
				"point_name": f"DEV-168 foreign {self.suffix}",
				"business_entity": self.entity.name,
				"city": "Ярославль",
				"address": "Integration test foreign",
				"active": 1,
			}
		).insert(ignore_permissions=True)
		self.workplace = frappe.db.get_value(
			"POS Workplace",
			{"business_point": self.point.name},
			"name",
		)
		self.assertTrue(self.workplace)
		phone_suffix = int(self.suffix, 16) % 10_000_000
		self.employee = frappe.get_doc(
			{
				"doctype": "Employee",
				"last_name": "Тестов",
				"first_name": f"Кассир{self.suffix[:4]}",
				"phone": f"+7999{phone_suffix:07d}",
				"business_entity": self.entity.name,
				"position": self.position.name,
				"employment_type": "Трудовой договор",
				"active": 1,
			}
		).insert(ignore_permissions=True)
		self.profile = frappe.get_doc(
			{
				"doctype": "Raspechatka User Profile",
				"last_name": "Тестов",
				"first_name": f"Кассир{self.suffix[:4]}",
				"phone": f"+7999{phone_suffix:07d}",
				"access_profile": "Raspechatka Cashier",
				"scope_type": "Points",
				"organization": self.organization.name,
				"business_entity": self.entity.name,
				"linked_employee": self.employee.name,
				"active": 1,
				"assigned_points": [{"business_point": self.point.name, "is_default": 1}],
			}
		).insert(ignore_permissions=True)
		self.device_id = f"DEV168-{self.suffix}"
		self.token = f"token-{self.suffix}"
		self.connection = frappe.get_doc(
			{
				"doctype": "POS Connection",
				"business_point": self.point.name,
				"device_id": self.device_id,
				"api_token": self.token,
				"enabled": 1,
			}
		).insert(ignore_permissions=True)

	def test_real_push_round_trip_scope_bootstrap_and_replay(self):
		order_number = f"ORD-DEV168-{self.suffix}"
		created_payload = {
			"orderNumber": order_number,
			"phone": "+7 900 123-45-67",
			"contactMethod": "Telegram @client",
			"comment": "Реальный DB regression",
			"status": "in_progress",
			"createdAt": "2026-09-20T09:00:00+03:00",
			"updatedAt": "2026-09-20T09:00:00+03:00",
			"dueAt": "2026-09-20T12:00:00+03:00",
			"sourceSaleId": f"SALE-{self.suffix}",
			"fiscalNumber": "777",
			"totalMinor": 12345,
			"paidMinor": 12345,
			"cashierId": self.employee.name,
			"lines": [
				{
					"productId": f"NOITEM-{self.suffix}",
					"name": "Фотокнига",
					"quantity": 1,
					"unitPriceMinor": 12345,
				}
			],
		}
		ready_payload = {
			**created_payload,
			"contactMethod": "WhatsApp +7 900 123-45-67",
			"status": "ready",
			"updatedAt": "2026-09-20T10:30:00+03:00",
			"readyAt": "2026-09-20T10:30:00+03:00",
		}
		create_event = {
			"id": f"CREATE-{self.suffix}",
			"eventType": "order.created",
			"payload": created_payload,
		}
		ready_event = {"id": f"READY-{self.suffix}", "eventType": "order.updated", "payload": ready_payload}

		result = pos_v2.push_events(
			self.device_id,
			self.token,
			events=[create_event, ready_event],
			app_version="dev168-test",
		)

		self.assertEqual(result, {"accepted": [create_event["id"], ready_event["id"]], "errors": []})
		order_names = frappe.get_all(
			"POS Order",
			filters={"order_number": order_number, "business_point": self.point.name},
			pluck="name",
		)
		self.assertEqual(len(order_names), 1)
		order = frappe.get_doc("POS Order", order_names[0])
		self.assertEqual(order.business_point, self.point.name)
		self.assertEqual(order.contact_method, ready_payload["contactMethod"])
		self.assertEqual(order.status, "Ready")
		self.assertEqual(order.source_pos_event, create_event["id"])
		self.assertEqual(order.source_sale_id, created_payload["sourceSaleId"])
		self.assertEqual(order.fiscal_number, "777")
		self.assertEqual(order.total_amount, 123.45)
		self.assertEqual(order.paid_amount, 123.45)
		self.assertEqual(len(order.items), 1)
		self.assertEqual(order.items[0].item_name, "Фотокнига")
		self.assertEqual(order.items[0].quantity, 1)
		self.assertEqual(order.items[0].rate, 123.45)
		self.assertEqual(
			frappe.utils.get_datetime(order.created_at),
			frappe.utils.get_datetime(pos_v2._normalize_v2_payload(created_payload)["createdAt"]),
		)
		self.assertEqual(
			frappe.utils.get_datetime(order.ready_at),
			frappe.utils.get_datetime(pos_v2._normalize_v2_payload(ready_payload)["readyAt"]),
		)

		current_scope = {"global": False, "points": [self.point.name]}
		with (
			patch.object(sales, "require_access"),
			patch.object(sales, "get_scope", return_value=current_scope),
			patch.object(sales, "get_allowed_entities", return_value=[self.entity.name]),
		):
			rows = sales.get_orders()["rows"]
			with self.assertRaises(frappe.PermissionError):
				sales.get_orders(business_point=self.foreign_point.name)
		web_order = next(row for row in rows if row["order_number"] == order_number)
		self.assertEqual(web_order["contact_method"], ready_payload["contactMethod"])

		foreign_scope = {"global": False, "points": [self.foreign_point.name]}
		with (
			patch.object(sales, "require_access"),
			patch.object(sales, "get_scope", return_value=foreign_scope),
			patch.object(sales, "get_allowed_entities", return_value=[self.entity.name]),
		):
			foreign_rows = sales.get_orders()["rows"]
		self.assertNotIn(order_number, [row["order_number"] for row in foreign_rows])

		bootstrap = pos_v2.get_bootstrap(
			self.device_id,
			self.token,
			cashier_id=self.employee.name,
		)
		bootstrap_order = next(
			row for row in bootstrap["workplaceData"]["orders"] if row["orderNumber"] == order_number
		)
		self.assertEqual(bootstrap_order["id"], order.name)
		self.assertEqual(bootstrap_order["contactMethod"], ready_payload["contactMethod"])
		self.assertEqual(bootstrap_order["status"], "ready")
		self.assertEqual(bootstrap_order["readyAt"], pos._pos_datetime_to_utc(order.ready_at))

		replay = pos_v2.push_events(
			self.device_id,
			self.token,
			events=[create_event],
			app_version="dev168-test",
		)
		self.assertEqual(replay, {"accepted": [create_event["id"]], "errors": []})
		self.assertEqual(
			frappe.db.count(
				"POS Order",
				filters={"order_number": order_number, "business_point": self.point.name},
			),
			1,
		)
		order.reload()
		self.assertEqual(order.contact_method, ready_payload["contactMethod"])
		self.assertEqual(order.last_pos_update_event, ready_event["id"])
		stale_event = {
			"id": f"STALE-{self.suffix}",
			"eventType": "order.updated",
			"payload": {
				**ready_payload,
				"updatedAt": "2026-09-20T10:00:00+03:00",
				"contactMethod": "stale",
				"status": "in_progress",
			},
		}
		for event in (ready_event, stale_event):
			replayed = pos_v2.push_events(self.device_id, self.token, events=[event])
			self.assertEqual(replayed["accepted"], [event["id"]])
		order.reload()
		self.assertEqual(order.contact_method, ready_payload["contactMethod"])
		self.assertEqual(order.status, "Ready")
		self.assertEqual(order.last_pos_update_event, ready_event["id"])

		missing_event = {
			"id": f"MISSING-{self.suffix}",
			"eventType": "order.updated",
			"payload": {
				"orderNumber": f"ORD-MISSING-{self.suffix}",
				"status": "ready",
				"readyAt": "2026-09-20T11:00:00+03:00",
				"cashierId": self.employee.name,
			},
		}
		missing = pos_v2.push_events(
			self.device_id,
			self.token,
			events=[missing_event],
			app_version="dev168-test",
		)
		self.assertEqual(missing["accepted"], [])
		self.assertEqual(missing["errors"][0]["id"], missing_event["id"])
		self.assertEqual(missing["errors"][0]["eventType"], "order.updated")
		self.assertIn("не найден", missing["errors"][0]["message"])
