import frappe


ROLES = (
	"Raspechatka Network Admin",
	"Raspechatka Franchise Owner",
	"Raspechatka Point Manager",
	"Raspechatka Cashier",
)


def execute():
	_create_roles()
	_create_positions()
	_create_payment_methods()
	_create_financial_articles()
	_create_point_infrastructure()
	_migrate_item_suppliers()


def _insert_if_missing(doctype, name, values):
	if frappe.db.exists(doctype, name):
		return frappe.get_doc(doctype, name)
	doc = frappe.get_doc({"doctype": doctype, **values})
	doc.insert(ignore_permissions=True)
	return doc


def _create_roles():
	for role_name in ROLES:
		_insert_if_missing("Role", role_name, {"role_name": role_name, "desk_access": 0})


def _create_positions():
	for position_name in ("Администратор сети", "Владелец франчайзи", "Управляющий", "Кассир"):
		_insert_if_missing("Position", position_name, {"position_name": position_name, "active": 1})


def _create_payment_methods():
	for method_name, method_type in (("Наличные", "Cash"), ("Банковская карта", "Card"), ("QR-код", "QR")):
		_insert_if_missing("Payment Method", method_name, {"method_name": method_name, "method_type": method_type, "active": 1, "system_method": 1})


def _create_financial_articles():
	for root_name, article_type, children in (
		("Доходы", "Income", ("Продажи", "Прочие доходы")),
		("Расходы", "Expense", ("Закупка товаров", "Аренда", "Зарплата", "Прочие расходы")),
	):
		_insert_if_missing("Financial Article", root_name, {"article_name": root_name, "article_type": article_type, "is_group": 1, "active": 1, "system_article": 1})
		for child_name in children:
			_insert_if_missing("Financial Article", child_name, {"article_name": child_name, "article_type": article_type, "parent_financial_article": root_name, "is_group": 0, "active": 1, "system_article": 1})


def _create_point_infrastructure():
	for point_name in frappe.get_all("Business Point", pluck="name"):
		frappe.get_doc("Business Point", point_name)._ensure_cash_infrastructure()


def _migrate_item_suppliers():
	for item in frappe.get_all("Catalog Item", fields=["name", "default_supplier"], filters={"default_supplier": ["is", "set"]}):
		if not frappe.db.exists("Catalog Item Supplier", {"item": item.name, "supplier": item.default_supplier}):
			frappe.get_doc({"doctype": "Catalog Item Supplier", "item": item.name, "supplier": item.default_supplier, "is_primary": 1, "active": 1}).insert(ignore_permissions=True)
