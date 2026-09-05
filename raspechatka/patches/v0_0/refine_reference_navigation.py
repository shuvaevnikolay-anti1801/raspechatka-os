import frappe


def execute():
	updates = {
		"references.network": {
			"area_name": "Партнёры, ИП и точки",
			"route": "/references/organizations",
		},
		"references.finance": {
			"area_name": "Финансовые настройки",
			"route": "/references/financial-articles",
		},
	}
	for area_code, values in updates.items():
		if frappe.db.exists("Access Area", area_code):
			frappe.db.set_value("Access Area", area_code, values, update_modified=False)
