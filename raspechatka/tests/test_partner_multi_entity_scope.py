from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka import access
from raspechatka.api import sales, team


def _scope(scope_type, entities, points, global_scope=False):
	return {
		"global": global_scope,
		"scope_type": scope_type,
		"organization": None if global_scope else "ORG-A",
		"business_entity": entities[0] if len(entities) == 1 else None,
		"business_entities": entities,
		"points": points,
	}


NETWORK = _scope("Network", [], [], True)
PARTNER_ONE = _scope("Partner", ["ENTITY-A1"], ["POINT-A1"])
PARTNER_MULTI = _scope("Partner", ["ENTITY-A1", "ENTITY-A2"], ["POINT-A1", "POINT-A2", "POINT-A3"])
BUSINESS_ENTITY = _scope("Business Entity", ["ENTITY-A1"], ["POINT-A1", "POINT-A2"])
POINTS = _scope("Points", ["ENTITY-A1"], ["POINT-A2"])


class TestAllowedEntities(TestCase):
	def test_all_scope_shapes_resolve_entities_without_broadening(self):
		self.assertIsNone(access.get_allowed_entities(NETWORK))
		self.assertEqual(access.get_allowed_entities(PARTNER_ONE), ["ENTITY-A1"])
		self.assertEqual(access.get_allowed_entities(PARTNER_MULTI), ["ENTITY-A1", "ENTITY-A2"])
		self.assertEqual(access.get_allowed_entities(BUSINESS_ENTITY), ["ENTITY-A1"])
		self.assertEqual(access.get_allowed_entities(POINTS), ["ENTITY-A1"])

	def test_legacy_single_entity_shape_is_supported_without_expansion(self):
		scope = {"global": False, "business_entity": "ENTITY-A1", "business_entities": [], "points": []}
		self.assertEqual(access.get_allowed_entities(scope), ["ENTITY-A1"])


class TestSalesPartnerScope(TestCase):
	def test_partner_multi_entity_options_include_all_entities_and_points(self):
		with patch.object(sales, "get_scope", return_value=PARTNER_MULTI):
			entity_filters, point_filters = sales._scope_filters()
		self.assertEqual(entity_filters["name"], ["in", ["ENTITY-A1", "ENTITY-A2"]])
		self.assertEqual(point_filters["name"], ["in", ["POINT-A1", "POINT-A2", "POINT-A3"]])

	def test_list_and_aggregate_filters_use_all_partner_points(self):
		with patch.object(sales, "get_scope", return_value=PARTNER_MULTI):
			point_filters = sales._business_point_filters()
			document_filters = sales._scope_point_filter()
		self.assertEqual(point_filters["name"], ["in", PARTNER_MULTI["points"]])
		self.assertEqual(document_filters["business_point"], ["in", PARTNER_MULTI["points"]])
		self.assertNotIn("business_entity", document_filters)

	def test_partner_can_select_either_own_entity_but_not_foreign_entity(self):
		with patch.object(sales, "get_scope", return_value=PARTNER_MULTI):
			filters = sales._scope_point_filter(business_entity="ENTITY-A2")
		self.assertEqual(filters["business_entity"], "ENTITY-A2")
		permission_error = type("PermissionError", (Exception,), {})
		fake_frappe = SimpleNamespace(
			PermissionError=permission_error, throw=Mock(side_effect=permission_error)
		)
		with (
			patch.object(sales, "get_scope", return_value=PARTNER_MULTI),
			patch.object(sales, "frappe", fake_frappe),
			self.assertRaises(permission_error),
		):
			sales._scope_point_filter(business_entity="ENTITY-B1")

	def test_direct_foreign_point_and_document_scope_are_denied(self):
		permission_error = type("PermissionError", (Exception,), {})
		fake_frappe = SimpleNamespace(
			PermissionError=permission_error, throw=Mock(side_effect=permission_error)
		)
		with (
			patch.object(sales, "get_scope", return_value=PARTNER_MULTI),
			patch.object(sales, "frappe", fake_frappe),
			self.assertRaises(permission_error),
		):
			sales._ensure_point("POINT-B1", "ENTITY-B1")

	def test_network_entity_and_point_filters_remain_unrestricted(self):
		with patch.object(sales, "get_scope", return_value=NETWORK):
			self.assertEqual(sales._scope_filters(), ({"active": 1}, {"active": 1}))


class TestTeamPartnerScope(TestCase):
	def test_partner_multi_entity_employees_and_payroll_are_not_empty(self):
		filters = team._employee_filters(PARTNER_MULTI)
		self.assertEqual(filters["business_entity"], ["in", ["ENTITY-A1", "ENTITY-A2"]])
		self.assertEqual(team._allowed_employee_entities(PARTNER_MULTI), ["ENTITY-A1", "ENTITY-A2"])

	def test_business_entity_and_points_scopes_keep_entity_boundary(self):
		self.assertEqual(team._employee_filters(BUSINESS_ENTITY)["business_entity"], ["in", ["ENTITY-A1"]])
		self.assertEqual(team._employee_filters(POINTS)["business_entity"], ["in", ["ENTITY-A1"]])

	def test_schedule_motivation_hr_and_settings_use_point_boundary(self):
		self.assertEqual(team._point_filters(PARTNER_MULTI)["name"], ["in", PARTNER_MULTI["points"]])
		self.assertEqual(team._point_filters(POINTS)["name"], ["in", ["POINT-A2"]])
