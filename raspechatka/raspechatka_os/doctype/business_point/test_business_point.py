import frappe
from frappe.tests import IntegrationTestCase


def _valid_inn12(seed):
	digits = [int(char) for char in f"{seed:010d}"[-10:]]
	check_11 = (
		sum(value * weight for value, weight in zip(digits, (7, 2, 4, 10, 3, 5, 9, 4, 6, 8), strict=True))
		% 11
		% 10
	)
	first_11 = [*digits, check_11]
	check_12 = (
		sum(
			value * weight for value, weight in zip(first_11, (3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8), strict=True)
		)
		% 11
		% 10
	)
	return "".join(str(value) for value in [*first_11, check_12])


class IntegrationTestBusinessPoint(IntegrationTestCase):
	def test_working_hours_survive_save_and_reopen(self):
		suffix = frappe.generate_hash(length=8)
		organization = frappe.get_doc(
			{
				"doctype": "Organization",
				"organization_code": f"TEST-{suffix}",
				"organization_name": f"Тестовый партнёр {suffix}",
				"organization_type": "Franchisee",
			}
		).insert(ignore_permissions=True)
		entity = frappe.get_doc(
			{
				"doctype": "Business Entity",
				"short_name": f"ИП Тест {suffix}",
				"full_name": f"Индивидуальный предприниматель Тест {suffix}",
				"organization": organization.name,
				"last_name": "Тестов",
				"first_name": "Тест",
				"inn": _valid_inn12(int.from_bytes(suffix.encode(), "big")),
				"tax_system": "Патент",
			}
		).insert(ignore_permissions=True)
		point = frappe.get_doc(
			{
				"doctype": "Business Point",
				"point_name": f"Ярославль, Тестовая, {suffix}",
				"business_entity": entity.name,
				"city": "Ярославль",
				"address": f"Тестовая, {suffix}",
				"timezone": "Asia/Yekaterinburg",
				"working_hours": [
					{
						"weekday": "Понедельник",
						"is_working": 1,
						"opens_at": "08:15",
						"closes_at": "19:45",
					}
				],
			}
		).insert(ignore_permissions=True)

		reopened = frappe.get_doc("Business Point", point.name)
		self.assertEqual(reopened.timezone, "Asia/Yekaterinburg")
		self.assertEqual(str(reopened.working_hours[0].opens_at), "8:15:00")
		self.assertEqual(str(reopened.working_hours[0].closes_at), "19:45:00")
