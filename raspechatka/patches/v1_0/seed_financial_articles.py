import frappe


ARTICLES = (
	("Продажа товаров и услуг", "Income", "Operating", 1, 1, 1),
	("Перемещение (приход)", "Income", "Transfer", 0, 0, 1),
	("Амортизация ОС", "Expense", "Operating", 1, 0, 0),
	("Аренда", "Expense", "Operating", 1, 1, 0),
	("Возврат", "Expense", "Operating", 0, 1, 1),
	("Закупка товаров", "Expense", "Operating", 1, 1, 1),
	("Зарплата", "Expense", "Operating", 1, 1, 0),
	("ИТ", "Expense", "Operating", 1, 1, 0),
	("Комиссия эквайринг QR", "Expense", "Operating", 1, 1, 0),
	("Логистика", "Expense", "Operating", 1, 1, 0),
	("Маркетинг и реклама", "Expense", "Operating", 1, 1, 0),
	("Налоги и сборы", "Expense", "Operating", 1, 1, 1),
	("Перемещение (расход)", "Expense", "Transfer", 0, 0, 1),
	("Платёж по кредиту", "Expense", "Financing", 0, 1, 0),
	("Прочие", "Expense", "Operating", 1, 1, 0),
	("Развитие", "Expense", "Investing", 0, 1, 0),
	("Содержание офиса", "Expense", "Operating", 1, 1, 0),
	("Списания", "Expense", "Operating", 1, 0, 1),
	("Услуги банка", "Expense", "Operating", 1, 1, 0),
)

EDITABLE_EXISTING = (
	"Аренда",
	"Зарплата",
	"Маркетинг и реклама",
)


def execute():
	for name, article_type, flow, pnl, cash_flow, system in ARTICLES:
		if frappe.db.exists("Financial Article", name):
			frappe.db.set_value(
				"Financial Article",
				name,
				{
					"article_type": article_type,
					"cash_flow_type": flow,
					"include_in_pnl": pnl,
					"include_in_cash_flow": cash_flow,
					"system_article": system,
					"active": 1,
				},
				update_modified=False,
			)
			continue
		frappe.get_doc(
			{
				"doctype": "Financial Article",
				"article_name": name,
				"article_type": article_type,
				"cash_flow_type": flow,
				"include_in_pnl": pnl,
				"include_in_cash_flow": cash_flow,
				"active": 1,
				"system_article": system,
				"is_group": 0,
			}
		).insert(ignore_permissions=True)

	for name in EDITABLE_EXISTING:
		if frappe.db.exists("Financial Article", name):
			frappe.db.set_value(
				"Financial Article",
				name,
				"system_article",
				0,
				update_modified=False,
			)
