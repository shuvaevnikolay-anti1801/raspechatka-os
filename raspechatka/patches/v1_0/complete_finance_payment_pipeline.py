import frappe

ACCESS_AREA = "finance.cash_expense"
ACCESS_LEVELS = {
	"Raspechatka Network Admin": "Admin",
	"Raspechatka Franchise Owner": "Edit",
	"Raspechatka Point Manager": "Edit",
	"Raspechatka Cashier": "Edit",
}


def execute():
	if not frappe.db.exists("Access Area", ACCESS_AREA):
		frappe.get_doc(
			{
				"doctype": "Access Area",
				"area_code": ACCESS_AREA,
				"area_name": "Наличные расходы",
				"route": "/finance/payments",
				"sort_order": 86,
				"active": 1,
				"system_area": 1,
			}
		).insert(ignore_permissions=True)

	settings = frappe.get_single("Raspechatka Access Settings")
	existing = {(row.role, row.access_area) for row in settings.rules}
	for role, level in ACCESS_LEVELS.items():
		if (role, ACCESS_AREA) not in existing:
			settings.append(
				"rules",
				{"role": role, "access_area": ACCESS_AREA, "access_level": level},
			)
	settings.save(ignore_permissions=True)

	frappe.db.sql(
		"""
		update `tabFinance Transaction`
		set processing_status = case
			when source = 'Tochka Bank' then 'Auto Posted'
			else 'Manual Posted'
		end
		where coalesce(processing_status, '') = ''
		"""
	)
	frappe.db.sql(
		"""
		update `tabBank Operation`
		set processed_at = modified
		where processing_status in ('Classified', 'Ignored', 'Error')
			and processed_at is null
		"""
	)
	frappe.db.sql(
		"""
		update `tabFinance Transaction`
		set operation_part_key = sha2(
			concat(bank_operation, '|', direction, '|', coalesce(comment, '')),
			256
		)
		where source = 'Tochka Bank'
			and bank_operation is not null
			and coalesce(operation_part_key, '') = ''
		"""
	)
