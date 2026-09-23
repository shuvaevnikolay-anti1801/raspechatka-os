from unittest import TestCase
from unittest.mock import patch

import frappe

from raspechatka.api import pos_v2, references


class _Point:
	def __init__(self, **values):
		self.values = dict(values)
		self.name = "POINT-A"

	def get(self, key):
		return self.values.get(key)

	def set(self, key, value):
		self.values[key] = value

	def save(self, **kwargs):
		pass

	def as_dict(self, **kwargs):
		return dict(self.values)


class TestPointCleaningReferences(TestCase):
	def test_defaults_and_custom_values(self):
		for payload, expected in [
			({"business_entity": "ENTITY-A"}, (2000, 4)),
			({"business_entity": "ENTITY-A", "cleaning_payout_amount": 3250.5, "cleaning_every_n_visits": 6}, (3250.5, 6)),
		]:
			point = _Point()
			with patch.object(references, "require_access") as access, patch.object(
				references, "_validate_payload_scope"
			), patch.object(references.frappe, "new_doc", return_value=point):
				references.save_reference("points", payload)
				access.assert_called_with("page.references.points", "create")
				self.assertEqual((point.get("cleaning_payout_amount"), point.get("cleaning_every_n_visits")), expected)

	def test_invalid_values_are_rejected(self):
		for field, value in [
			("cleaning_payout_amount", 0), ("cleaning_payout_amount", -1),
			("cleaning_payout_amount", "bad"), ("cleaning_every_n_visits", 0),
			("cleaning_every_n_visits", 1.5), ("cleaning_every_n_visits", "bad"),
		]:
			with self.subTest(field=field, value=value), patch.object(
				references, "require_access"
			), patch.object(references, "_validate_payload_scope"), patch.object(
				references.frappe, "new_doc", return_value=_Point()
			):
				with self.assertRaises(Exception):
					references.save_reference("points", {"business_entity": "ENTITY-A", field: value})

	def test_foreign_point_is_denied_before_update(self):
		with patch.object(references, "require_access") as access, patch.object(
			references, "_scope_filters", return_value={"business_entity": ["in", ["ENTITY-A"]]}
		), patch.object(references.frappe.db, "exists", return_value=False), patch.object(
			references.frappe, "get_doc"
		) as get_doc:
			with self.assertRaises(frappe.PermissionError):
				references.save_reference("points", {"name": "FOREIGN", "cleaning_payout_amount": 3000})
			access.assert_called_with("page.references.points", "write")
			get_doc.assert_not_called()

	def test_detail_defaults_for_existing_unset_point(self):
		point = _Point(cleaning_payout_amount=None, cleaning_every_n_visits=None)
		with patch.object(references, "require_access") as access, patch.object(
			references, "_scope_filters", return_value={}
		), patch.object(references.frappe.db, "exists", return_value=True), patch.object(
			references.frappe, "get_doc", return_value=point
		):
			result = references.get_reference_detail("points", "POINT-A")
			access.assert_called_with("page.references.points", "read")
			self.assertEqual((result["cleaning_payout_amount"], result["cleaning_every_n_visits"]), (2000, 4))


class TestPointCleaningBootstrap(TestCase):
	def test_bootstrap_carries_point_cleaning_config(self):
		point = frappe._dict(
			name="POINT-A", point_name="Point", timezone="Europe/Moscow", active=1,
			cleaning_payout_amount=3250.5, cleaning_every_n_visits=6,
		)
		connection = frappe._dict(business_point="POINT-A")
		workplace = frappe._dict(name="POS-A", workplace_name="Касса")
		with patch.object(pos_v2.base_pos, "_authenticate", return_value=connection), patch.object(
			pos_v2.frappe, "get_doc", return_value=point
		), patch.object(pos_v2.base_pos, "_workplace", return_value=workplace), patch.object(
			pos_v2.base_pos, "_point_employees", return_value=[]
		), patch.object(pos_v2.base_pos, "_bootstrap_employee", return_value=None), patch.object(
			pos_v2.base_pos, "_touch"
		), patch.object(pos_v2, "_products", return_value=[]), patch.object(
			pos_v2, "_customers", return_value=[]
		), patch.object(pos_v2, "_rules", return_value={}), patch.object(
			pos_v2, "_upsell_rules", return_value=[]
		), patch.object(pos_v2, "_receipt_mirror", return_value=[]), patch.object(
			pos_v2.legacy_pos, "_get_workplace_data", return_value={}
		), patch.object(pos_v2, "get_effective_site_timezone", return_value="Europe/Moscow"):
			result = pos_v2.get_bootstrap("device", "token")
			self.assertEqual(result["point"]["cleaning"], {"payoutAmountMinor": 325050, "everyNVisits": 6})
