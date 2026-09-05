import frappe


AREAS = (
	("finance.operations", "Платежи и взаиморасчёты", "/finance/payments", 86),
	("finance.planning", "Платёжный календарь и планирование", "/finance/calendar", 87),
	("finance.reporting", "Финансовые отчёты", "/finance/report", 88),
	("finance.bank", "Интеграция с банком", "/finance/tochka", 89),
)

LEVELS = {
	"Raspechatka Network Admin": ("Admin", "Admin", "Admin", "Admin"),
	"Raspechatka Franchise Owner": ("Edit", "Edit", "View", "Edit"),
	"Raspechatka Point Manager": ("Edit", "Edit", "View", "None"),
	"Raspechatka Cashier": ("View", "None", "View", "None"),
}

ARTICLES = (
	("Выручка", "Income", "Operating", 1, 1),
	("Прочие поступления", "Income", "Operating", 1, 1),
	("Взнос владельца", "Income", "Financing", 0, 1),
	("Получение кредита", "Income", "Financing", 0, 1),
	("Материалы и товары", "Expense", "Operating", 1, 1),
	("Аренда", "Expense", "Operating", 1, 1),
	("Коммунальные услуги", "Expense", "Operating", 1, 1),
	("Зарплата", "Expense", "Operating", 1, 1),
	("Налоги и взносы", "Expense", "Operating", 1, 1),
	("Маркетинг и реклама", "Expense", "Operating", 1, 1),
	("Комиссии банка", "Expense", "Operating", 1, 1),
	("Списание материалов", "Expense", "Operating", 1, 0),
	("Оборудование и развитие", "Expense", "Investing", 0, 1),
	("Погашение кредита", "Expense", "Financing", 0, 1),
	("Вывод денег владельцем", "Expense", "Financing", 0, 1),
	("Прочие расходы", "Expense", "Operating", 1, 1),
)


def execute():
	for code, label, route, order in AREAS:
		if not frappe.db.exists("Access Area", code):
			frappe.get_doc({"doctype": "Access Area", "area_code": code, "area_name": label, "route": route, "sort_order": order, "active": 1, "system_area": 1}).insert(ignore_permissions=True)
	doc = frappe.get_single("Raspechatka Access Settings")
	existing = {(row.role, row.access_area) for row in doc.rules}
	for role, levels in LEVELS.items():
		for area, level in zip(AREAS, levels):
			if (role, area[0]) not in existing:
				doc.append("rules", {"role": role, "access_area": area[0], "access_level": level})
	doc.save(ignore_permissions=True)
	for name, article_type, flow, pnl, cash_flow in ARTICLES:
		if not frappe.db.exists("Financial Article", name):
			frappe.get_doc({"doctype": "Financial Article", "article_name": name, "article_type": article_type, "cash_flow_type": flow, "include_in_pnl": pnl, "include_in_cash_flow": cash_flow, "active": 1, "system_article": 1, "is_group": 0}).insert(ignore_permissions=True)
		else:
			frappe.db.set_value("Financial Article", name, {"cash_flow_type": flow, "include_in_pnl": pnl, "include_in_cash_flow": cash_flow}, update_modified=False)
