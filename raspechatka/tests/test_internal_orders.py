from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka import scope as scope_api
from raspechatka.api import internal_orders


class FakeFrappe:
	class PermissionError(Exception):
		pass

	def __init__(self):
		self.calls = []
		self.orders = [
			SimpleNamespace(
				name="NEED-2026-00001",
				request_date="2026-09-22",
				creation="2026-09-22 10:15:00",
				business_point="POINT-1",
				requested_by_employee="EMP-1",
				item="ITEM-1",
				item_name="Фотобумага A4",
				quantity=3.0,
				comment="Заканчивается на точке",
				status="Новая",
			),
			SimpleNamespace(
				name="NEED-2026-00002",
				request_date="2026-09-22",
				creation="2026-09-22 10:20:00",
				business_point="POINT-2",
				requested_by_employee="EMP-2",
				item=None,
				item_name="Скотч",
				quantity=2.0,
				comment="Чужая точка",
				status="В работе",
			),
		]
		self.points = {
			"POINT-1": SimpleNamespace(name="POINT-1", point_name="Распечатка — Центр"),
			"POINT-2": SimpleNamespace(name="POINT-2", point_name="Распечатка — Чужая"),
		}
		self.employees = {
			"EMP-1": SimpleNamespace(name="EMP-1", employee_name="Иван Петров"),
			"EMP-2": SimpleNamespace(name="EMP-2", employee_name="Чужой Кассир"),
		}

	def throw(self, message, exception=None):
		raise (exception or RuntimeError)(message)

	def get_all(self, doctype, filters=None, or_filters=None, **kwargs):
		self.calls.append((doctype, filters, or_filters, kwargs))
		filters = filters or {}
		if doctype == "Point Supply Request":
			rows = list(self.orders)
			point = filters.get("business_point")
			if isinstance(point, list) and point and point[0] == "in":
				rows = [row for row in rows if row.business_point in point[1]]
			elif point:
				rows = [row for row in rows if row.business_point == point]
			if filters.get("status"):
				rows = [row for row in rows if row.status == filters["status"]]
			if or_filters:
				needles = [
					str(value[1]).strip("%").lower()
					for value in or_filters.values()
					if isinstance(value, list) and len(value) > 1
				]
				needle = needles[0] if needles else ""
				rows = [
					row
					for row in rows
					if needle
					in " ".join(
						str(getattr(row, field, "") or "")
						for field in ("name", "item_name", "comment")
					).lower()
				]
			start = kwargs.get("limit_start", 0)
			length = kwargs.get("limit_page_length")
			return rows[start : start + length] if length else rows
		if doctype == "Business Point":
			names = (filters.get("name") or ["in", []])[1]
			return [self.points[name] for name in names if name in self.points]
		if doctype == "Employee":
			names = (filters.get("name") or ["in", []])[1]
			return [self.employees[name] for name in names if name in self.employees]
		raise AssertionError(f"Unexpected doctype: {doctype}")


POINT_SCOPE = {
	"global": False,
	"scope_type": "Points",
	"business_entities": ["ENTITY-1"],
	"points": ["POINT-1"],
}


class TestInternalOrdersApi(TestCase):
	def setUp(self):
		self.fake = FakeFrappe()
		self.scope_patch = patch.object(scope_api, "_scope", return_value=POINT_SCOPE)
		self.frappe_patch = patch.object(internal_orders, "frappe", self.fake)
		self.scope_frappe_patch = patch.object(scope_api, "frappe", self.fake)
		self.scope_patch.start()
		self.frappe_patch.start()
		self.scope_frappe_patch.start()

	def tearDown(self):
		self.scope_frappe_patch.stop()
		self.frappe_patch.stop()
		self.scope_patch.stop()

	def test_current_point_is_visible_and_pos_supply_fields_map_to_owner_api(self):
		result = internal_orders._get_internal_orders()

		self.assertEqual(result["start"], 0)
		self.assertEqual(result["page_length"], 50)
		self.assertFalse(result["has_more"])
		self.assertEqual(
			result["rows"],
			[
				{
					"name": "NEED-2026-00001",
					"request_date": "2026-09-22",
					"creation": "2026-09-22 10:15:00",
					"business_point": "POINT-1",
					"business_point_label": "Распечатка — Центр",
					"requested_by_employee": "EMP-1",
					"requested_by_employee_label": "Иван Петров",
					"item": "ITEM-1",
					"item_name": "Фотобумага A4",
					"quantity": 3.0,
					"comment": "Заканчивается на точке",
					"status": "Новая",
				}
			],
		)
		self.assertEqual(sum(call[0] == "Business Point" for call in self.fake.calls), 1)
		self.assertEqual(sum(call[0] == "Employee" for call in self.fake.calls), 1)

	def test_foreign_rows_are_hidden_and_foreign_point_filter_is_blocked(self):
		self.assertEqual(
			[row["name"] for row in internal_orders._get_internal_orders()["rows"]],
			["NEED-2026-00001"],
		)
		with self.assertRaises(self.fake.PermissionError):
			internal_orders._get_internal_orders(business_point="POINT-2")

	def test_search_status_pagination_and_options_share_point_scope(self):
		result = internal_orders._get_internal_orders(
			search="фотобумага",
			status="Новая",
			business_point="POINT-1",
			start=0,
			page_length=1,
		)
		self.assertEqual([row["name"] for row in result["rows"]], ["NEED-2026-00001"])
		self.assertFalse(result["has_more"])

		options = internal_orders._get_internal_order_options()
		self.assertEqual(options["points"], [{"value": "POINT-1", "label": "Распечатка — Центр"}])
		self.assertEqual(
			[value["value"] for value in options["statuses"]],
			list(internal_orders.STATUS_OPTIONS),
		)

	def test_endpoint_denies_before_read_when_page_view_is_missing(self):
		denied = PermissionError("Нет доступа")
		with patch.object(internal_orders, "require_access", Mock(side_effect=denied)):
			endpoint = getattr(internal_orders.get_internal_orders, "__wrapped__", internal_orders.get_internal_orders)
			with self.assertRaises(PermissionError):
				endpoint()
		self.assertFalse(any(call[0] == "Point Supply Request" for call in self.fake.calls))
