# ruff: noqa: RUF001
from datetime import datetime, time, timedelta

import frappe
from frappe import _
from frappe.utils import flt, get_first_day, get_last_day, getdate, nowdate

from raspechatka.access import get_scope, require_access


@frappe.whitelist()
def get_control_center(
	period="today",
	from_date=None,
	to_date=None,
	business_entity=None,
	city=None,
	business_point=None,
):
	require_access("page.dashboard", "read")
	start, end = _period_dates(period, from_date, to_date)
	points = _points(business_entity, city, business_point)
	point_names = [row.name for row in points]
	period_days = (end - start).days + 1
	previous_start = start - timedelta(days=period_days)
	previous_end = start - timedelta(days=1)

	current = _sales_totals(point_names, start, end)
	previous = _sales_totals(point_names, previous_start, previous_end)
	plans = _plans(points, start, end, allow_entity_plan=not city and not business_point)
	alerts = _alerts(points)

	return {
		"filters": _filter_options(),
		"period": {"from_date": str(start), "to_date": str(end)},
		"metrics": _metrics(current["totals"], previous["totals"], plans["totals"]),
		"alerts": alerts[:30],
		"dynamics": _dynamics(point_names, start, end),
		"points": _point_rows(points, current["by_point"], previous["by_point"], plans["by_point"], alerts),
		"upcoming_events": _upcoming_events(points),
	}


def _period_dates(period, from_date, to_date):
	today = getdate(nowdate())
	if period == "today":
		return today, today
	if period == "yesterday":
		yesterday = today - timedelta(days=1)
		return yesterday, yesterday
	if period == "week":
		return today - timedelta(days=today.weekday()), today
	if period == "custom":
		start, end = getdate(from_date or today), getdate(to_date or today)
		if start > end:
			frappe.throw(_("Дата начала не может быть позже даты окончания."))
		return start, end
	return getdate(get_first_day(today)), today


def _filter_options():
	points = _points()
	entity_names = sorted({row.business_entity for row in points if row.business_entity})
	return {
		"entities": frappe.get_all(
			"Business Entity",
			filters={"name": ["in", entity_names or ["__none__"]]},
			fields=["name", "short_name"],
			order_by="short_name asc",
			limit_page_length=0,
		),
		"points": points,
	}


def _points(business_entity=None, city=None, business_point=None):
	filters = {"active": 1}
	scope = get_scope()
	if not scope["global"]:
		filters["name"] = ["in", scope["points"] or ["__none__"]]
	if business_entity:
		filters["business_entity"] = business_entity
	if city:
		filters["city"] = city
	if business_point:
		filters["name"] = business_point

	rows = frappe.get_all(
		"Business Point",
		filters=filters,
		fields=["name", "point_name", "business_entity", "city", "address"],
		order_by="city asc, point_name asc",
		limit_page_length=0,
	)
	if business_point and not rows:
		frappe.throw(_("Точка продаж недоступна."), frappe.PermissionError)
	return rows


def _sales_totals(points, start, end):
	empty = {"revenue": 0, "cost": 0, "profit": 0, "receipts": 0, "returns": 0}
	if not points:
		return {"totals": dict(empty), "by_point": {}}

	placeholders = ", ".join(["%s"] * len(points))
	rows = frappe.db.sql(
		f"""select business_point,
			coalesce(sum(case when receipt_type='Sale' then total_amount else -total_amount end), 0) revenue,
			coalesce(sum(case when receipt_type='Sale' then cost_amount else -cost_amount end), 0) cost,
			coalesce(sum(case when receipt_type='Sale' then profit_amount else -profit_amount end), 0) profit,
			sum(case when receipt_type='Sale' then 1 else 0 end) receipts,
			sum(case when receipt_type='Return' then 1 else 0 end) returns
		from `tabSales Receipt`
		where docstatus=1 and business_point in ({placeholders})
			and posting_datetime between %s and %s
		group by business_point""",
		(*points, datetime.combine(start, time.min), datetime.combine(end, time.max)),
		as_dict=True,
	)
	by_point = {row.business_point: _numeric(row) for row in rows}
	totals = {key: sum(row[key] for row in by_point.values()) for key in empty}
	return {"totals": totals, "by_point": by_point}


def _numeric(row):
	return {
		"revenue": flt(row.get("revenue")),
		"cost": flt(row.get("cost")),
		"profit": flt(row.get("profit")),
		"receipts": int(row.get("receipts") or 0),
		"returns": int(row.get("returns") or 0),
	}


def _plans(points, start, end, allow_entity_plan):
	by_point = {row.name: {"revenue": 0, "checks": 0, "average_check": 0} for row in points}
	point_entities = {row.name: row.business_entity for row in points}
	entities = sorted({entity for entity in point_entities.values() if entity})
	totals = {"revenue": 0, "checks": 0, "average_check": 0}
	average_check_values = []

	month = getdate(get_first_day(start))
	last_month = getdate(get_first_day(end))
	while month <= last_month:
		month_end = getdate(get_last_day(month))
		active_start, active_end = max(start, month), min(end, month_end)
		share = ((active_end - active_start).days + 1) / month_end.day
		budgets = frappe.get_all(
			"Finance Budget",
			filters={"month": month, "business_entity": ["in", entities or ["__none__"]]},
			fields=["business_entity", "business_point", "revenue_plan", "checks_plan", "average_check_plan"],
			limit_page_length=0,
		)
		point_budgets = {row.business_point: row for row in budgets if row.business_point in by_point}
		entity_budgets = {row.business_entity: row for row in budgets if not row.business_point}

		for point_name, budget in point_budgets.items():
			bucket = by_point[point_name]
			bucket["revenue"] += flt(budget.revenue_plan) * share
			bucket["checks"] += flt(budget.checks_plan) * share
			bucket["average_check"] = flt(budget.average_check_plan)
			totals["revenue"] += flt(budget.revenue_plan) * share
			totals["checks"] += flt(budget.checks_plan) * share
			if flt(budget.average_check_plan):
				average_check_values.append(flt(budget.average_check_plan))

		if allow_entity_plan:
			for entity in entities:
				if any(point_entities[name] == entity for name in point_budgets):
					continue
				budget = entity_budgets.get(entity)
				if not budget:
					continue
				totals["revenue"] += flt(budget.revenue_plan) * share
				totals["checks"] += flt(budget.checks_plan) * share
				if flt(budget.average_check_plan):
					average_check_values.append(flt(budget.average_check_plan))

		month = getdate(get_first_day(month_end + timedelta(days=1)))

	totals["average_check"] = (
		totals["revenue"] / totals["checks"]
		if totals["checks"]
		else sum(average_check_values) / len(average_check_values)
		if average_check_values
		else 0
	)
	return {"totals": totals, "by_point": by_point}


def _metrics(current, previous, plan):
	average_check = current["revenue"] / current["receipts"] if current["receipts"] else 0
	previous_check = previous["revenue"] / previous["receipts"] if previous["receipts"] else 0
	margin = current["profit"] / current["revenue"] * 100 if current["revenue"] else 0
	return {
		"revenue": _metric(current["revenue"], previous["revenue"], plan["revenue"]),
		"profit": {**_metric(current["profit"], previous["profit"]), "margin": margin},
		"receipts": {
			**_metric(current["receipts"], previous["receipts"], plan["checks"]),
			"returns": current["returns"],
		},
		"average_check": _metric(average_check, previous_check, plan["average_check"]),
	}


def _metric(value, previous, plan=0):
	return {
		"value": value,
		"plan": plan,
		"attainment": value / plan * 100 if plan else None,
		"delta": (value - previous) / previous * 100 if previous else None,
	}


def _dynamics(points, start, end):
	if not points:
		return []
	placeholders = ", ".join(["%s"] * len(points))
	group = "date_format(posting_datetime, '%%H:00')" if start == end else "date(posting_datetime)"
	rows = frappe.db.sql(
		f"""select {group} label,
			coalesce(sum(case when receipt_type='Sale' then total_amount else -total_amount end), 0) value
		from `tabSales Receipt`
		where docstatus=1 and business_point in ({placeholders})
			and posting_datetime between %s and %s
		group by {group}
		order by min(posting_datetime)""",
		(*points, datetime.combine(start, time.min), datetime.combine(end, time.max)),
		as_dict=True,
	)
	return [{"label": str(row.label), "value": flt(row.value)} for row in rows]


def _alerts(points):
	point_names = [row.name for row in points]
	if not point_names:
		return []

	alerts = []
	warehouses = frappe.get_all(
		"Catalog Warehouse",
		filters={"business_point": ["in", point_names], "active": 1},
		fields=["name", "business_point"],
		limit_page_length=0,
	)
	warehouse_point = {row.name: row.business_point for row in warehouses}
	rules = frappe.get_all(
		"Catalog Reorder Rule",
		filters={"warehouse": ["in", list(warehouse_point) or ["__none__"]]},
		fields=["parent", "warehouse", "minimum_stock"],
		limit_page_length=0,
	)
	balances = {
		(row.item, row.warehouse): flt(row.actual_qty)
		for row in frappe.get_all(
			"Stock Balance",
			filters={"warehouse": ["in", list(warehouse_point) or ["__none__"]]},
			fields=["item", "warehouse", "actual_qty"],
			limit_page_length=0,
		)
	}
	rule_items = list({rule.parent for rule in rules})
	item_names = {
		row.name: row.item_name
		for row in frappe.get_all(
			"Catalog Item",
			filters={"name": ["in", rule_items or ["__none__"]]},
			fields=["name", "item_name"],
			limit_page_length=0,
		)
	}
	for rule in rules:
		quantity = balances.get((rule.parent, rule.warehouse), 0)
		minimum = flt(rule.minimum_stock)
		if minimum and quantity <= minimum:
			alerts.append(
				_alert(
					"critical" if quantity <= 0 else "warning",
					warehouse_point[rule.warehouse],
					"Товар закончился" if quantity <= 0 else "Товар заканчивается",
					f"{item_names.get(rule.parent, rule.parent)}: остаток {quantity:g}, минимум {minimum:g}.",
					"/warehouse/balances",
				)
			)

	today = getdate(nowdate())
	for order in frappe.get_all(
		"Purchase Order",
		filters={"business_point": ["in", point_names], "docstatus": 1},
		fields=[
			"name",
			"business_point",
			"expected_date",
			"payment_due_date",
			"outstanding_amount",
			"order_status",
		],
		limit_page_length=0,
	):
		if order.expected_date and getdate(order.expected_date) < today and order.order_status != "Принято":
			alerts.append(
				_alert(
					"warning",
					order.business_point,
					"Поставка задерживается",
					f"Заказ {order.name}: ожидаемая дата {order.expected_date}.",
					"/warehouse/purchase-orders",
				)
			)
		if order.payment_due_date and getdate(order.payment_due_date) < today and flt(order.outstanding_amount) > 0:
			alerts.append(
				_alert(
					"critical",
					order.business_point,
					"Просрочен платёж поставщику",
					f"Заказ {order.name}: задолженность {flt(order.outstanding_amount):g} ₽.",
					"/finance/settlements",
				)
			)

	for connection in frappe.get_all(
		"POS Connection",
		filters={"business_point": ["in", point_names], "enabled": 1},
		fields=["business_point", "status", "last_error"],
		limit_page_length=0,
	):
		if connection.status in {"Нет связи", "Ошибка"}:
			alerts.append(
				_alert(
					"critical",
					connection.business_point,
					"Касса не подключена",
					connection.last_error or f"Состояние подключения: {connection.status}.",
					"/sales/integration",
				)
			)

	entities = list({row.business_entity for row in points if row.business_entity})
	bank_count = frappe.db.count(
		"Bank Operation",
		{
			"business_entity": ["in", entities or ["__none__"]],
			"processing_status": ["in", ["New", "Review", "Error"]],
		},
	)
	if bank_count:
		alerts.append(
			_alert(
				"warning",
				None,
				"Есть необработанные банковские операции",
				f"Требуют проверки: {bank_count}.",
				"/finance/tochka",
			)
		)

	priority = {"critical": 0, "warning": 1, "info": 2}
	return sorted(
		alerts,
		key=lambda row: (priority[row["level"]], row["title"], row.get("business_point") or ""),
	)


def _alert(level, point, title, message, route):
	return {
		"level": level,
		"business_point": point,
		"title": title,
		"message": message,
		"route": route,
	}


def _point_rows(points, current, previous, plans, alerts):
	alert_counts = {}
	for alert in alerts:
		if alert.get("business_point"):
			alert_counts[alert["business_point"]] = alert_counts.get(alert["business_point"], 0) + 1

	result = []
	for point in points:
		values = current.get(point.name, _numeric({}))
		old = previous.get(point.name, _numeric({}))
		plan = plans.get(point.name, {})
		average_check = values["revenue"] / values["receipts"] if values["receipts"] else 0
		result.append(
			{
				**point,
				**values,
				"average_check": average_check,
				"margin": values["profit"] / values["revenue"] * 100 if values["revenue"] else 0,
				"delta": _metric(values["revenue"], old["revenue"])["delta"],
				"plan_attainment": (
					values["revenue"] / flt(plan.get("revenue")) * 100
					if flt(plan.get("revenue"))
					else None
				),
				"alerts": alert_counts.get(point.name, 0),
			}
		)
	return sorted(
		result,
		key=lambda row: (-row["alerts"], -(row["plan_attainment"] or 0), row["point_name"]),
	)


def _upcoming_events(points):
	point_names = [row.name for row in points]
	today = getdate(nowdate())
	horizon = today + timedelta(days=7)
	events = []

	for row in frappe.get_all(
		"Purchase Order",
		filters={
			"business_point": ["in", point_names or ["__none__"]],
			"docstatus": 1,
			"expected_date": ["between", [today, horizon]],
		},
		fields=["name", "business_point", "expected_date", "supplier"],
		order_by="expected_date asc",
		limit_page_length=20,
	):
		events.append(
			{
				"date": str(row.expected_date),
				"type": "Поставка",
				"title": row.supplier or row.name,
				"business_point": row.business_point,
				"route": "/warehouse/purchase-orders",
			}
		)

	for row in frappe.get_all(
		"Purchase Order",
		filters={
			"business_point": ["in", point_names or ["__none__"]],
			"docstatus": 1,
			"payment_due_date": ["between", [today, horizon]],
			"outstanding_amount": [">", 0],
		},
		fields=["name", "business_point", "payment_due_date", "outstanding_amount"],
		order_by="payment_due_date asc",
		limit_page_length=20,
	):
		events.append(
			{
				"date": str(row.payment_due_date),
				"type": "Платёж",
				"title": f"{flt(row.outstanding_amount):g} ₽ по заказу {row.name}",
				"business_point": row.business_point,
				"route": "/finance/settlements",
			}
		)

	return sorted(events, key=lambda row: (row["date"], row["type"]))[:20]
