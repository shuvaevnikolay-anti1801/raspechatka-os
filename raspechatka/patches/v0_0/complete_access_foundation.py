import frappe


AREAS = (
	("dashboard", "Главная и показатели", "/", 10),
	("references.network", "Участники сети, ИП и точки", "/references/organizations", 20),
	("references.storage", "Склады и адресное хранение", "/references/warehouses", 30),
	("references.clients", "Клиенты", "/references/clients", 40),
	("references.suppliers", "Поставщики", "/references/suppliers", 50),
	("references.employees", "Сотрудники и должности", "/references/employees", 60),
	("references.catalog", "Каталог и его настройки", "/catalog", 70),
	("references.finance", "Кассы и финансовые статьи", "/references/cash-registers", 80),
	("settings.access", "Настройка прав доступа", "/settings/access", 90),
)

DEFAULTS = {
	"Raspechatka Network Admin": {code: "Admin" for code, *_rest in AREAS},
	"Raspechatka Franchise Owner": {
		"dashboard": "View", "references.network": "Edit", "references.storage": "Edit",
		"references.clients": "Edit", "references.suppliers": "Edit", "references.employees": "Edit",
		"references.catalog": "View", "references.finance": "Edit", "settings.access": "None",
	},
	"Raspechatka Point Manager": {
		"dashboard": "View", "references.network": "View", "references.storage": "Edit",
		"references.clients": "Edit", "references.suppliers": "View", "references.employees": "View",
		"references.catalog": "View", "references.finance": "Edit", "settings.access": "None",
	},
	"Raspechatka Cashier": {
		"dashboard": "View", "references.network": "None", "references.storage": "View",
		"references.clients": "Edit", "references.suppliers": "None", "references.employees": "None",
		"references.catalog": "View", "references.finance": "View", "settings.access": "None",
	},
}


def execute():
	for code, name, route, order in AREAS:
		if not frappe.db.exists("Access Area", code):
			frappe.get_doc({"doctype": "Access Area", "area_code": code, "area_name": name, "route": route, "sort_order": order, "active": 1, "system_area": 1}).insert(ignore_permissions=True)
	doc = frappe.get_single("Raspechatka Access Settings")
	existing = {(row.role, row.access_area) for row in doc.rules}
	for role, levels in DEFAULTS.items():
		for code, _name, _route, _order in AREAS:
			if (role, code) not in existing:
				doc.append("rules", {"role": role, "access_area": code, "access_level": levels[code]})
	doc.save(ignore_permissions=True)
