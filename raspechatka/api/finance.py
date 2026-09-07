from collections import defaultdict
from datetime import date, datetime, time

import frappe
from frappe import _
from frappe.utils import add_months, cint, flt, get_first_day, get_last_day, getdate, nowdate, nowtime

from raspechatka.access import get_scope, require_access


@frappe.whitelist()
def get_finance_options():
	require_access("finance.operations", "read")
	entity_filters, point_filters = _scope_filters()
	scope = get_scope()
	account_filters = {"active": 1}
	if not scope["global"]:
		account_filters["business_entity"] = scope["business_entity"] or "__none__"
	return {
		"entities": frappe.get_all("Business Entity", filters=entity_filters, fields=["name", "short_name"], order_by="short_name asc"),
		"points": frappe.get_all("Business Point", filters=point_filters, fields=["name", "point_name", "business_entity"], order_by="point_name asc"),
		"accounts": frappe.get_all("Business Bank Account", filters=account_filters, fields=["name", "bank_name", "settlement_account", "business_entity"], order_by="bank_name asc"),
		"articles": frappe.get_all("Financial Article", filters={"active": 1, "is_group": 0}, fields=["name", "article_name", "article_type", "cash_flow_type", "include_in_pnl", "include_in_cash_flow"], order_by="article_type asc, article_name asc"),
		"payment_methods": _get_payment_method_options(),
	}


def _get_payment_method_options():
	"""Return payment methods using the stable API key expected by the frontend."""
	rows = frappe.get_all(
		"Payment Method",
		filters={"active": 1},
		fields=["name", "method_name"],
		order_by="method_name asc",
	)
	for row in rows:
		row["payment_method_name"] = row.get("method_name") or row.get("name")
	return rows


@frappe.whitelist()
def get_payments(from_date=None, to_date=None, business_entity=None, business_point=None, direction=None, financial_article=None, status=None, search=None, limit_start=0, limit_page_length=100):
	require_access("finance.operations", "read")
	filters = _transaction_filters(from_date, to_date, business_entity, business_point, direction, financial_article, status)
	query = (search or "").strip()
	or_filters = None
	if query:
		value = f"%{query}%"
		or_filters = {"purpose": ["like", value], "counterparty_name": ["like", value], "document_number": ["like", value], "name": ["like", value]}
	limit = min(max(cint(limit_page_length), 1), 500)
	rows = frappe.get_all("Finance Transaction", filters=filters, or_filters=or_filters, fields=["name", "posting_date", "posting_time", "direction", "amount", "currency", "status", "docstatus", "business_entity", "business_point", "bank_account", "financial_article", "cash_flow_type", "counterparty_name", "purpose", "source", "document_number"], order_by="posting_date desc, posting_time desc, creation desc", limit_start=max(cint(limit_start), 0), limit_page_length=limit + 1)
	visible = rows[:limit]
	return {"rows": visible, "has_more": len(rows) > limit, "totals": _payment_totals(visible)}


@frappe.whitelist()
def get_payment(name=None, direction="Expense"):
	require_access("finance.operations", "read")
	if name:
		doc = frappe.get_doc("Finance Transaction", name)
		_ensure_entity(doc.business_entity)
		return doc.as_dict(no_nulls=False)
	return {"posting_date": nowdate(), "posting_time": nowtime(), "direction": direction, "amount": 0, "currency": "RUB", "status": "Draft", "cash_flow_type": "Operating", "source": "Manual"}


@frappe.whitelist(methods=["POST"])
def save_payment(data, submit=0):
	data = frappe.parse_json(data) or {}
	require_access("finance.operations", "write" if data.get("name") else "create")
	_ensure_entity(data.get("business_entity"))
	_ensure_point(data.get("business_point"), data.get("business_entity"))
	doc = frappe.get_doc("Finance Transaction", data["name"]) if data.get("name") else frappe.new_doc("Finance Transaction")
	if doc.docstatus:
		frappe.throw(_("Проведённый платёж нельзя редактировать. Отмените его и создайте новый."))
	allowed = ("posting_date", "posting_time", "direction", "amount", "currency", "business_entity", "business_point", "bank_account", "financial_article", "cash_flow_type", "counterparty_type", "supplier", "client", "employee", "counterparty_name", "purpose", "document_number", "payment_method", "comment")
	for fieldname in allowed:
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.source = doc.source or "Manual"
	doc.save(ignore_permissions=True)
	if cint(submit):
		doc.submit()
		_link_plan(doc)
	return {"name": doc.name, "docstatus": doc.docstatus, "status": doc.status}


@frappe.whitelist(methods=["POST"])
def cancel_payment(name):
	require_access("finance.operations", "write")
	doc = frappe.get_doc("Finance Transaction", name)
	_ensure_entity(doc.business_entity)
	if doc.docstatus == 1:
		doc.cancel()
	return {"name": doc.name, "docstatus": doc.docstatus}


@frappe.whitelist()
def get_payment_calendar(month=None, business_entity=None, business_point=None, status=None):
	require_access("finance.planning", "read")
	month = getdate(month or get_first_day(nowdate())).replace(day=1)
	filters = {"planned_date": ["between", [get_first_day(month), get_last_day(month)]]}
	filters.update(_scope_entity_filter(business_entity))
	if business_point:
		_ensure_point(business_point, business_entity)
		filters["business_point"] = business_point
	if status:
		filters["status"] = status
	rows = frappe.get_all("Finance Plan Item", filters=filters, fields=["name", "title", "planned_date", "direction", "amount", "currency", "status", "business_entity", "business_point", "bank_account", "financial_article", "counterparty_name", "recurrence", "paid_transaction", "comment"], order_by="planned_date asc, creation asc", limit_page_length=1000)
	today = getdate(nowdate())
	for row in rows:
		row["display_status"] = "Overdue" if row.status == "Planned" and getdate(row.planned_date) < today else row.status
	return {"rows": rows, "totals": {"planned": sum(flt(row.amount) for row in rows), "paid": sum(flt(row.amount) for row in rows if row.status == "Paid"), "remaining": sum(flt(row.amount) for row in rows if row.status == "Planned")}, "month": str(month)}


@frappe.whitelist(methods=["POST"])
def save_plan_item(data):
	data = frappe.parse_json(data) or {}
	require_access("finance.planning", "write" if data.get("name") else "create")
	_ensure_entity(data.get("business_entity"))
	_ensure_point(data.get("business_point"), data.get("business_entity"))
	doc = frappe.get_doc("Finance Plan Item", data["name"]) if data.get("name") else frappe.new_doc("Finance Plan Item")
	allowed = ("title", "planned_date", "direction", "amount", "currency", "status", "business_entity", "business_point", "bank_account", "financial_article", "counterparty_name", "recurrence", "recurrence_day", "recurrence_until", "comment")
	for fieldname in allowed:
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def delete_plan_item(name):
	require_access("finance.planning", "write")
	doc = frappe.get_doc("Finance Plan Item", name)
	_ensure_entity(doc.business_entity)
	if doc.status == "Paid":
		frappe.throw(_("Оплаченный пункт календаря нельзя удалить"))
	frappe.delete_doc("Finance Plan Item", name, ignore_permissions=True)
	return {"deleted": True}


@frappe.whitelist()
def get_financial_report(month=None, business_entity=None, business_point=None):
	require_access("finance.reporting", "read")
	month = getdate(month or get_first_day(nowdate())).replace(day=1)
	start, end = get_first_day(month), get_last_day(month)
	filters = _transaction_filters(start, end, business_entity, business_point, status="Posted")
	transactions = frappe.get_all("Finance Transaction", filters=filters, fields=["direction", "amount", "financial_article", "cash_flow_type", "posting_date"], limit_page_length=100000)
	articles = {row.name: row for row in frappe.get_all("Financial Article", fields=["name", "article_name", "article_type", "include_in_pnl", "include_in_cash_flow", "cash_flow_type"], limit_page_length=10000)}
	profitability_filters = {"posting_date": ["between", [start, end]], **_scope_entity_filter(business_entity)}
	if business_point:
		profitability_filters["business_point"] = business_point
	profitability = frappe.get_all("Profitability Entry", filters=profitability_filters, fields=["revenue", "return_amount", "discount_amount", "cost_amount"], limit_page_length=100000)
	has_pos_sales = bool(profitability)
	pos_revenue = sum(flt(row.revenue) - flt(row.return_amount) - flt(row.discount_amount) for row in profitability)
	pos_cost = sum(flt(row.cost_amount) for row in profitability)
	budget = _get_budget(month, business_entity, business_point)
	plan_by_article = {row.financial_article: flt(row.amount) for row in (budget.lines if budget else [])}
	actual_by_article = defaultdict(float)
	for row in transactions:
		actual_by_article[row.financial_article] += flt(row.amount)
	article_rows = []
	for name in sorted(set(plan_by_article) | set(actual_by_article), key=lambda value: (articles.get(value).article_type if articles.get(value) else "", articles.get(value).article_name if articles.get(value) else value or "")):
		article = articles.get(name)
		if not article:
			continue
		plan, actual = plan_by_article.get(name, 0), actual_by_article.get(name, 0)
		article_rows.append({"article": name, "article_name": article.article_name, "article_type": article.article_type, "plan": plan, "actual": actual, "variance": actual - plan})
	income = sum(flt(row.amount) for row in transactions if row.direction == "Income" and (not row.financial_article or cint(articles.get(row.financial_article).include_in_pnl if articles.get(row.financial_article) else 1)) and not (has_pos_sales and articles.get(row.financial_article) and articles[row.financial_article].article_name == "Выручка"))
	expense = sum(flt(row.amount) for row in transactions if row.direction == "Expense" and (not row.financial_article or cint(articles.get(row.financial_article).include_in_pnl if articles.get(row.financial_article) else 1)))
	if has_pos_sales:
		income += pos_revenue
		expense += pos_cost
		article_rows.insert(0, {"article": "__pos_sales__", "article_name": "Продажи по кассе", "article_type": "Income", "plan": 0, "actual": pos_revenue, "variance": pos_revenue})
		article_rows.insert(1, {"article": "__pos_cost__", "article_name": "Себестоимость продаж", "article_type": "Expense", "plan": 0, "actual": pos_cost, "variance": pos_cost})
	flow = {kind: {"income": 0.0, "expense": 0.0, "net": 0.0} for kind in ("Operating", "Investing", "Financing")}
	for row in transactions:
		article = articles.get(row.financial_article)
		if article and not cint(article.include_in_cash_flow):
			continue
		kind = row.cash_flow_type or (article.cash_flow_type if article else "Operating")
		if kind not in flow:
			continue
		key = "income" if row.direction == "Income" else "expense"
		flow[kind][key] += flt(row.amount)
	for values in flow.values():
		values["net"] = values["income"] - values["expense"]
	opening_cash = flt(budget.opening_cash_plan if budget else 0)
	net_cash = sum(row["net"] for row in flow.values())
	inventory = _inventory_value(end, business_entity, business_point)
	equipment = flt(budget.equipment_value if budget else 0)
	loans = flt(budget.loan_balance if budget else 0)
	liabilities = flt(budget.other_liabilities if budget else 0)
	closing_cash = opening_cash + net_cash
	plan_revenue = flt(budget.revenue_plan if budget else 0)
	plan_profit = flt(budget.net_profit_plan if budget else 0)
	checks = cint(budget.checks_plan if budget else 0)
	return {
		"period": {"month": str(month), "from_date": str(start), "to_date": str(end)},
		"pnl": {"revenue": income, "expenses": expense, "net_profit": income - expense, "margin": ((income - expense) / income * 100) if income else 0},
		"cash_flow": {"opening_cash": opening_cash, "sections": flow, "net_cash_flow": net_cash, "closing_cash": closing_cash},
		"balance": {"cash": closing_cash, "inventory": inventory, "equipment": equipment, "assets": closing_cash + inventory + equipment, "loans": loans, "other_liabilities": liabilities, "liabilities": loans + liabilities, "net_position": closing_cash + inventory + equipment - loans - liabilities},
		"plan_fact": {"revenue_plan": plan_revenue, "revenue_actual": income, "revenue_attainment": income / plan_revenue * 100 if plan_revenue else 0, "profit_plan": plan_profit, "profit_actual": income - expense, "profit_attainment": (income - expense) / plan_profit * 100 if plan_profit else 0, "checks_plan": checks, "average_check_plan": flt(budget.average_check_plan if budget else 0)},
		"articles": article_rows,
	}


@frappe.whitelist()
def get_budget(month=None, business_entity=None, business_point=None):
	require_access("finance.planning", "read")
	month = getdate(month or get_first_day(nowdate())).replace(day=1)
	budget = _get_budget(month, business_entity, business_point)
	return budget.as_dict(no_nulls=False) if budget else {"month": str(month), "business_entity": business_entity, "business_point": business_point, "revenue_plan": 0, "checks_plan": 0, "average_check_plan": 0, "net_profit_plan": 0, "opening_cash_plan": 0, "equipment_value": 0, "loan_balance": 0, "other_liabilities": 0, "lines": []}


@frappe.whitelist(methods=["POST"])
def save_budget(data):
	data = frappe.parse_json(data) or {}
	require_access("finance.planning", "write" if data.get("name") else "create")
	_ensure_entity(data.get("business_entity"))
	_ensure_point(data.get("business_point"), data.get("business_entity"))
	doc = frappe.get_doc("Finance Budget", data["name"]) if data.get("name") else frappe.new_doc("Finance Budget")
	for fieldname in ("month", "business_entity", "business_point", "revenue_plan", "checks_plan", "average_check_plan", "net_profit_plan", "opening_cash_plan", "equipment_value", "loan_balance", "other_liabilities", "comment"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.set("lines", [])
	for row in data.get("lines") or []:
		doc.append("lines", {"financial_article": row.get("financial_article"), "amount": row.get("amount"), "comment": row.get("comment")})
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist()
def get_settlements(from_date=None, to_date=None, business_entity=None, business_point=None, search=None):
	require_access("finance.reporting", "read")
	filters = _transaction_filters(from_date, to_date, business_entity, business_point, status="Posted")
	rows = frappe.get_all("Finance Transaction", filters=filters, fields=["counterparty_name", "counterparty_type", "supplier", "client", "employee", "direction", "amount"], limit_page_length=100000)
	result = {}
	for row in rows:
		key = (row.counterparty_type or "Other", row.supplier or row.client or row.employee or row.counterparty_name or "Без контрагента")
		bucket = result.setdefault(key, {"counterparty_type": key[0], "counterparty": key[1], "income": 0.0, "expense": 0.0})
		bucket["income" if row.direction == "Income" else "expense"] += flt(row.amount)
	planned_filters = {"status": "Planned", **_scope_entity_filter(business_entity)}
	if business_point:
		planned_filters["business_point"] = business_point
	for row in frappe.get_all("Finance Plan Item", filters=planned_filters, fields=["counterparty_name", "direction", "amount"], limit_page_length=100000):
		key = ("Other", row.counterparty_name or "Без контрагента")
		bucket = result.setdefault(key, {"counterparty_type": key[0], "counterparty": key[1], "income": 0.0, "expense": 0.0})
		bucket["receivable" if row.direction == "Income" else "payable"] = bucket.get("receivable" if row.direction == "Income" else "payable", 0) + flt(row.amount)
	query = (search or "").strip().lower()
	values = [{**row, "balance": row.get("income", 0) - row.get("expense", 0), "receivable": row.get("receivable", 0), "payable": row.get("payable", 0)} for row in result.values() if not query or query in row["counterparty"].lower()]
	values.sort(key=lambda row: row["counterparty"])
	return {"rows": values, "totals": {key: sum(row[key] for row in values) for key in ("income", "expense", "balance", "receivable", "payable")}}


@frappe.whitelist()
def get_profitability(from_date=None, to_date=None, business_entity=None, business_point=None, catalog_group=None, search=None):
	require_access("finance.reporting", "read")
	filters = {"posting_date": ["between", [from_date or get_first_day(nowdate()), to_date or nowdate()]]}
	filters.update(_scope_entity_filter(business_entity))
	if business_point:
		filters["business_point"] = business_point
	rows = frappe.get_all("Profitability Entry", filters=filters, fields=["item", "quantity", "revenue", "cost_amount", "return_amount", "discount_amount"], limit_page_length=100000)
	items = {row.name: row for row in frappe.get_all("Catalog Item", fields=["name", "item_name", "item_code", "catalog_group"], limit_page_length=100000)}
	aggregated = {}
	for row in rows:
		item = items.get(row.item)
		if not item or (catalog_group and item.catalog_group != catalog_group):
			continue
		key = row.item
		bucket = aggregated.setdefault(key, {"item": key, "item_name": item.item_name, "item_code": item.item_code, "catalog_group": item.catalog_group, "documents": 0, "quantity": 0.0, "revenue": 0.0, "cost": 0.0, "returns": 0.0, "discounts": 0.0})
		bucket["documents"] += 1; bucket["quantity"] += flt(row.quantity); bucket["revenue"] += flt(row.revenue); bucket["cost"] += flt(row.cost_amount); bucket["returns"] += flt(row.return_amount); bucket["discounts"] += flt(row.discount_amount)
	query = (search or "").strip().lower()
	result = []
	for row in aggregated.values():
		if query and query not in f"{row['item_name']} {row['item_code']}".lower():
			continue
		row["profit"] = row["revenue"] - row["returns"] - row["discounts"] - row["cost"]
		row["margin"] = row["profit"] / row["revenue"] * 100 if row["revenue"] else 0
		result.append(row)
	result.sort(key=lambda row: row["profit"], reverse=True)
	keys = ("documents", "quantity", "revenue", "cost", "returns", "discounts", "profit")
	return {"rows": result, "totals": {key: sum(row[key] for row in result) for key in keys}, "source_ready": frappe.db.count("Profitability Entry") > 0}


@frappe.whitelist()
def get_finance_settings():
	require_access("finance.operations", "admin")
	return {
		"articles": frappe.get_all(
			"Financial Article",
			fields=[
				"name",
				"article_name",
				"article_type",
				"active",
				"system_article",
			],
			order_by="article_type asc, article_name asc",
			limit_page_length=1000,
		)
	}


@frappe.whitelist(methods=["POST"])
def save_financial_article(data):
	require_access("finance.operations", "admin")
	data = frappe.parse_json(data) or {}
	name = data.get("name")
	if name:
		doc = frappe.get_doc("Financial Article", name)
		if doc.system_article:
			frappe.throw(_("Системную финансовую статью нельзя изменять"))
		if data.get("article_type") and data.get("article_type") != doc.article_type:
			frappe.throw(_("Тип существующей статьи изменить нельзя"))
	else:
		doc = frappe.new_doc("Financial Article")
		doc.article_type = data.get("article_type")
		doc.cash_flow_type = "Operating"
		doc.include_in_pnl = 1
		doc.include_in_cash_flow = 1
		doc.is_group = 0
		doc.system_article = 0
	doc.article_name = (data.get("article_name") or "").strip()
	doc.active = cint(data.get("active", 1))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def delete_financial_article(name):
	require_access("finance.operations", "admin")
	doc = frappe.get_doc("Financial Article", name)
	if doc.system_article:
		frappe.throw(_("Системную финансовую статью нельзя удалить"))
	frappe.delete_doc("Financial Article", name, ignore_permissions=True)
	return {"deleted": name}


def _transaction_filters(from_date=None, to_date=None, business_entity=None, business_point=None, direction=None, financial_article=None, status=None):
	filters = _scope_entity_filter(business_entity)
	if from_date and to_date:
		filters["posting_date"] = ["between", [from_date, to_date]]
	elif from_date:
		filters["posting_date"] = [">=", from_date]
	elif to_date:
		filters["posting_date"] = ["<=", to_date]
	if business_point:
		_ensure_point(business_point, business_entity)
		filters["business_point"] = business_point
	if direction:
		filters["direction"] = direction
	if financial_article:
		filters["financial_article"] = financial_article
	if status:
		filters["status"] = status
	return filters


def _scope_filters():
	scope = get_scope()
	if scope["global"]:
		return {"active": 1}, {"active": 1}
	return {"active": 1, "name": scope["business_entity"] or "__none__"}, {"active": 1, "name": ["in", scope["points"] or ["__none__"]]}


def _scope_entity_filter(business_entity=None):
	scope = get_scope()
	if not scope["global"]:
		if business_entity and business_entity != scope["business_entity"]:
			frappe.throw(_("ИП недоступно"), frappe.PermissionError)
		return {"business_entity": scope["business_entity"] or "__none__"}
	if business_entity:
		return {"business_entity": business_entity}
	return {}


def _ensure_entity(entity):
	if not entity or not frappe.db.exists("Business Entity", entity):
		frappe.throw(_("Выберите ИП"))
	_scope_entity_filter(entity)


def _ensure_point(point, entity=None):
	if not point:
		return
	scope = get_scope()
	if not scope["global"] and point not in (scope["points"] or []):
		frappe.throw(_("Точка недоступна"), frappe.PermissionError)
	point_entity = frappe.db.get_value("Business Point", point, "business_entity")
	if entity and point_entity != entity:
		frappe.throw(_("Точка продаж должна относиться к выбранному ИП"))


def _payment_totals(rows):
	income = sum(flt(row.amount) for row in rows if row.direction == "Income" and row.docstatus != 2)
	expense = sum(flt(row.amount) for row in rows if row.direction == "Expense" and row.docstatus != 2)
	return {"income": income, "expense": expense, "net": income - expense}


def _get_budget(month, business_entity=None, business_point=None):
	if get_scope()["global"] and not business_entity:
		return None
	filters = {"month": getdate(month).replace(day=1), **_scope_entity_filter(business_entity)}
	filters["business_point"] = business_point if business_point else ["is", "not set"]
	name = frappe.db.get_value("Finance Budget", filters, "name")
	return frappe.get_doc("Finance Budget", name) if name else None


def _inventory_value(as_of, business_entity=None, business_point=None):
	warehouse_filters = {"active": 1}
	if business_point:
		warehouse_filters["business_point"] = business_point
	elif business_entity:
		points = frappe.get_all("Business Point", filters={"business_entity": business_entity}, pluck="name")
		warehouse_filters["business_point"] = ["in", points or ["__none__"]]
	else:
		scope = get_scope()
		if not scope["global"]:
			warehouse_filters["business_point"] = ["in", scope["points"] or ["__none__"]]
	warehouses = frappe.get_all("Catalog Warehouse", filters=warehouse_filters, pluck="name")
	if not warehouses:
		return 0
	end = datetime.combine(getdate(as_of), time.max)
	values = frappe.get_all("Stock Ledger Entry", filters={"warehouse": ["in", warehouses], "posting_datetime": ["<=", end]}, pluck="stock_value_difference", limit_page_length=100000)
	return sum(flt(value) for value in values)


def _link_plan(transaction):
	if not transaction.plan_item:
		return
	plan = frappe.get_doc("Finance Plan Item", transaction.plan_item)
	plan.status = "Paid"
	plan.paid_transaction = transaction.name
	plan.save(ignore_permissions=True)
