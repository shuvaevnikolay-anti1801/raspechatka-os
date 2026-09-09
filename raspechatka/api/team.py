from calendar import monthrange
from datetime import date

import frappe
from frappe import _
from frappe.utils import cint, flt, get_datetime, get_url, getdate, now_datetime, time_diff_in_hours

from raspechatka.access import get_scope, require_access
from raspechatka.requisites import digits


def _scope_point(business_point=None):
	scope = get_scope()
	if business_point and not scope["global"] and business_point not in scope["points"]:
		frappe.throw(_("Точка недоступна"), frappe.PermissionError)
	return scope


def _point_filters(scope):
	return {"active": 1} if scope["global"] else {
		"active": 1,
		"name": ["in", scope["points"] or ["__none__"]],
	}


def _employee_filters(scope, business_point=None):
	filters = {"active": 1}
	if not scope["global"]:
		filters["business_entity"] = scope["business_entity"] or "__none__"
	if business_point:
		parents = frappe.get_all(
			"Employee Point Assignment",
			filters={"business_point": business_point},
			pluck="parent",
		)
		filters["name"] = ["in", parents or ["__none__"]]
	return filters


@frappe.whitelist()
def get_team_overview(business_point=None, month=None):
	require_access("team.employees", "read")
	scope = _scope_point(business_point)
	month = getdate(month or date.today().replace(day=1))
	month = month.replace(day=1)

	points = frappe.get_all(
		"Business Point",
		filters=_point_filters(scope),
		fields=["name", "point_name", "business_entity", "city"],
		order_by="point_name asc",
		limit_page_length=500,
	)
	employees = frappe.get_all(
		"Employee",
		filters=_employee_filters(scope, business_point),
		fields=[
			"name", "employee_name", "first_name", "business_entity", "position",
			"hire_date", "dismissal_date", "active",
		],
		order_by="employee_name asc",
		limit_page_length=500,
	)

	assignments = frappe.get_all(
		"Employee Point Assignment",
		filters={"parent": ["in", [row.name for row in employees] or ["__none__"]]},
		fields=["parent", "business_point", "is_default"],
		limit_page_length=2000,
	)
	by_employee = {}
	for row in assignments:
		by_employee.setdefault(row.parent, []).append(row)
	for employee in employees:
		rows = by_employee.get(employee.name, [])
		employee["points"] = [row.business_point for row in rows]
		employee["default_point"] = next((row.business_point for row in rows if row.is_default), None)

	schedule_filters = {"month": month}
	if business_point:
		schedule_filters["business_point"] = business_point
	elif not scope["global"]:
		schedule_filters["business_point"] = ["in", scope["points"] or ["__none__"]]
	schedules = frappe.get_all(
		"Work Schedule",
		filters=schedule_filters,
		fields=["name", "business_point", "month", "status", "published_at"],
		order_by="business_point asc",
		limit_page_length=500,
	)

	motivation_filters = {"status": "Active"}
	if business_point:
		motivation_filters["business_point"] = business_point
	elif not scope["global"]:
		motivation_filters["business_point"] = ["in", scope["points"] or ["__none__"]]
	motivation = frappe.get_all(
		"Motivation Period",
		filters=motivation_filters,
		fields=["name", "title", "business_point", "start_date", "end_date", "rules_version"],
		order_by="start_date desc",
		limit_page_length=20,
	)

	payroll_filters = {"active": 1}
	if business_point:
		payroll_filters["business_point"] = ["in", ["", business_point]]
		payroll_filters["business_entity"] = frappe.db.get_value("Business Point", business_point, "business_entity")
	elif not scope["global"]:
		payroll_filters["business_entity"] = scope["business_entity"] or "__none__"
	payroll_components = frappe.get_all(
		"Payroll Accrual Type",
		filters=payroll_filters,
		fields=[
			"name", "component_code", "component_name", "business_entity",
			"business_point", "calculation_basis", "default_rate",
			"default_percent", "payment_method",
		],
		order_by="component_name asc",
		limit_page_length=500,
	)

	shift_templates = frappe.get_all(
		"Shift Template",
		filters={"active": 1},
		fields=["name", "shift_code", "shift_name", "start_time", "end_time", "paid_hours"],
		order_by="start_time asc",
		limit_page_length=100,
	)

	return {
		"month": str(month),
		"points": points,
		"employees": employees,
		"schedules": schedules,
		"motivation_periods": motivation,
		"payroll_components": payroll_components,
		"shift_templates": shift_templates,
		"counters": {
			"active_employees": len(employees),
			"points": len(points),
			"published_schedules": sum(1 for row in schedules if row.status == "Published"),
			"active_games": len(motivation),
		},
	}


@frappe.whitelist()
def get_schedule(business_point, month=None):
	require_access("team.schedule", "read")
	_scope_point(business_point)
	month = getdate(month or date.today().replace(day=1)).replace(day=1)
	name = frappe.db.get_value(
		"Work Schedule",
		{"business_point": business_point, "month": month},
		"name",
	)
	if not name:
		return {"name": None, "month": str(month), "days": monthrange(month.year, month.month)[1], "entries": []}
	doc = frappe.get_doc("Work Schedule", name)
	period_start = get_datetime(f"{month} 00:00:00")
	period_end = get_datetime(f"{month.replace(day=monthrange(month.year, month.month)[1])} 23:59:59")
	actual_shifts = frappe.get_all(
		"Sales Shift",
		filters={"business_point": business_point, "opened_at": ["between", [period_start, period_end]]},
		fields=["name", "cashier", "opened_at", "closed_at", "status", "net_sales", "average_check"],
		order_by="opened_at asc",
		limit_page_length=1000,
	)
	actual_by_employee_date = {}
	for shift in actual_shifts:
		key = (str(getdate(shift.opened_at)), shift.cashier)
		actual_by_employee_date.setdefault(key, []).append(shift)
	return {
		"name": doc.name,
		"business_point": doc.business_point,
		"month": str(doc.month),
		"status": doc.status,
		"days": monthrange(month.year, month.month)[1],
		"entries": [
			dict({
				"date": str(row.work_date),
				"employee": row.employee,
				"shift_template": row.shift_template,
				"start_time": str(row.start_time or ""),
				"end_time": str(row.end_time or ""),
				"planned_hours": flt(row.planned_hours),
			}, **_actual_shift_summary(actual_by_employee_date.get((str(row.work_date), row.employee), [])))
			for row in doc.entries
		],
	}


def _actual_shift_summary(shifts):
	if not shifts:
		return {"actual_shift": None, "actual_hours": 0, "net_sales": 0, "actual_status": None}
	closed = [row for row in shifts if row.closed_at]
	return {
		"actual_shift": ", ".join(row.name for row in shifts),
		"actual_hours": sum(time_diff_in_hours(row.closed_at, row.opened_at) for row in closed),
		"net_sales": sum(flt(row.net_sales) for row in shifts),
		"actual_status": "Closed" if len(closed) == len(shifts) else "Open",
	}


@frappe.whitelist()
def recalculate_motivation(period):
	"""Rebuild employee motivation results from confirmed POS shifts and cashier actions."""
	require_access("team.motivation", "write")
	doc = frappe.get_doc("Motivation Period", period)
	_scope_point(doc.business_point)
	period_start = get_datetime(f"{doc.start_date} 00:00:00")
	period_end = get_datetime(f"{doc.end_date} 23:59:59")
	employees = frappe.get_all(
		"Employee Point Assignment",
		filters={"business_point": doc.business_point},
		pluck="parent",
		limit_page_length=500,
	)
	metrics = {
		employee: {"REVIEW": 0, "CLUB": 0, "GIFT": 0, "AVG_CHECK_SHIFT": 0, "gift_tiers": {}}
		for employee in employees
	}
	action_codes = {
		"REVIEW_RECEIVED": "REVIEW",
		"CLUB_REGISTRATION": "CLUB",
		"GIFT_ORDER": "GIFT",
	}
	for row in frappe.get_all(
		"Cashier Action",
		filters={
			"business_point": doc.business_point,
			"action_datetime": ["between", [period_start, period_end]],
			"action_type": ["in", list(action_codes)],
		},
		fields=["cashier", "action_type", "metric_value", "gift_tier"],
		limit_page_length=100000,
	):
		if row.cashier not in metrics:
			continue
		value = cint(row.metric_value) or 1
		code = action_codes[row.action_type]
		metrics[row.cashier][code] += value
		if code == "GIFT" and row.gift_tier:
			metrics[row.cashier]["gift_tiers"][row.gift_tier] = metrics[row.cashier]["gift_tiers"].get(row.gift_tier, 0) + value
	for row in frappe.get_all(
		"Sales Shift",
		filters={
			"business_point": doc.business_point,
			"opened_at": ["between", [period_start, period_end]],
			"status": "Closed",
		},
		fields=["cashier", "average_check"],
		limit_page_length=100000,
	):
		if row.cashier in metrics and flt(row.average_check) >= flt(doc.average_check_threshold):
			metrics[row.cashier]["AVG_CHECK_SHIFT"] += 1

	team_facts = {
		code: sum(values[code] for values in metrics.values())
		for code in ("REVIEW", "CLUB", "GIFT", "AVG_CHECK_SHIFT")
	}
	team_checks = [
		team_facts.get(rule.rule_code, 0) >= flt(rule.team_plan)
		for rule in doc.rules if flt(rule.team_plan) > 0
	]
	team_achieved = (
		(all(team_checks) if doc.team_logic == "AND" else any(team_checks))
		if team_checks else False
	)
	calculated = []
	for employee, values in metrics.items():
		action_reward = 0
		points = 0
		missing = []
		for rule in doc.rules:
			fact = values.get(rule.rule_code, 0)
			multiplier = flt(doc.premium_multiplier) if doc.focus_code == rule.rule_code else 1
			points_multiplier = flt(doc.points_multiplier) if doc.focus_code == rule.rule_code else 1
			if rule.rule_code == "GIFT" and values["gift_tiers"]:
				reward = (
					values["gift_tiers"].get("GIFT_1", 0) * flt(rule.reward_1)
					+ values["gift_tiers"].get("GIFT_2", 0) * flt(rule.reward_2)
					+ values["gift_tiers"].get("GIFT_3", 0) * flt(rule.reward_3)
				)
			else:
				reward = fact * flt(rule.reward)
			action_reward += reward * multiplier
			points += fact * flt(rule.points) * points_multiplier
			if flt(rule.personal_minimum) > fact:
				missing.append(f"{rule.rule_title}: ещё {flt(rule.personal_minimum) - fact:g}")
		calculated.append({
			"employee": employee,
			"values": values,
			"action_reward": action_reward,
			"points": points,
			"admitted": not missing,
			"missing_text": "; ".join(missing),
		})
	eligible = sorted((row for row in calculated if row["admitted"]), key=lambda row: (-row["points"], row["employee"]))
	places = {row["employee"]: index + 1 for index, row in enumerate(eligible)}
	for row in calculated:
		result_name = frappe.db.get_value(
			"Employee Motivation Result",
			{"motivation_period": doc.name, "employee": row["employee"]},
			"name",
		)
		result = frappe.get_doc("Employee Motivation Result", result_name) if result_name else frappe.new_doc("Employee Motivation Result")
		result.motivation_period = doc.name
		result.employee = row["employee"]
		result.reviews = row["values"]["REVIEW"]
		result.clubs = row["values"]["CLUB"]
		result.gifts = row["values"]["GIFT"]
		result.high_check_shifts = row["values"]["AVG_CHECK_SHIFT"]
		result.action_reward = row["action_reward"]
		result.points = row["points"]
		result.admitted = row["admitted"]
		result.place = places.get(row["employee"])
		result.leader_bonus = flt(doc.leader_bonus) if result.place == 1 else 0
		result.team_bonus = flt(doc.team_bonus_each) if team_achieved and result.admitted else 0
		result.total_bonus = flt(result.action_reward) + flt(result.leader_bonus) + flt(result.team_bonus)
		result.missing_text = row["missing_text"]
		result.computed_at = now_datetime()
		result.source = "Shift Journal"
		result.save(ignore_permissions=True)
	doc.puzzle_filled_pieces = min(cint(doc.puzzle_total_pieces) or 100, sum(team_facts.values()))
	doc.save(ignore_permissions=True)
	return {"updated": len(calculated), "team_achieved": team_achieved}


@frappe.whitelist()
def get_game_data(period=None, business_point=None):
	"""Authenticated JSON contract used by the existing game page.

	A separate token-protected integration endpoint will be needed before Tilda can
	call this method without a Raspechatka OS session.
	"""
	require_access("team.motivation", "read")
	scope = _scope_point(business_point)
	if period:
		filters = {"name": period}
	else:
		filters = {"status": "Active"}
		if business_point:
			filters["business_point"] = business_point
		elif not scope["global"]:
			filters["business_point"] = ["in", scope["points"] or ["__none__"]]
		periods = frappe.get_all(
			"Motivation Period",
			filters=filters,
			pluck="name",
			order_by="start_date desc",
			limit_page_length=1,
		)
		period = periods[0] if periods else None
	if not period:
		frappe.throw(_("Активный мотивационный период не найден"))
	doc = frappe.get_doc("Motivation Period", period)
	_scope_point(doc.business_point)

	results = frappe.get_all(
		"Employee Motivation Result",
		filters={"motivation_period": doc.name},
		fields=[
			"name", "employee", "reviews", "clubs", "gifts", "high_check_shifts",
			"action_reward", "points", "admitted", "place", "leader_bonus",
			"team_bonus", "total_bonus", "missing_text", "computed_at",
		],
		order_by="place asc, points desc",
		limit_page_length=500,
	)
	employee_names = {
		row.name: row
		for row in frappe.get_all(
			"Employee",
			filters={"name": ["in", [row.employee for row in results] or ["__none__"]]},
			fields=["name", "employee_name", "first_name"],
		)
	}

	employees = []
	for index, row in enumerate(results):
		employee = employee_names.get(row.employee) or {}
		employees.append({
			"id": row.employee,
			"name": employee.get("first_name") or employee.get("employee_name") or row.employee,
			"profileIndex": index,
			"reviews": cint(row.reviews),
			"clubs": cint(row.clubs),
			"gifts": cint(row.gifts),
			"highCheckShifts": cint(row.high_check_shifts),
			"actionReward": flt(row.action_reward),
			"points": flt(row.points),
			"admitted": bool(row.admitted),
			"place": cint(row.place) or None,
			"leaderBonus": flt(row.leader_bonus),
			"teamBonus": flt(row.team_bonus),
			"totalBonus": flt(row.total_bonus),
			"missingText": row.missing_text or "",
		})

	metric_by_code = {
		"REVIEW": "reviews",
		"CLUB": "clubs",
		"GIFT": "gifts",
		"AVG_CHECK_SHIFT": "high_check_shifts",
	}
	rules = []
	for rule in doc.rules:
		metric = metric_by_code.get(rule.rule_code)
		fact = sum(cint(row.get(metric)) for row in results) if metric else 0
		reward_text = f"+{flt(rule.reward):g} ₽"
		if rule.rule_code == "GIFT":
			rewards = [flt(rule.reward_1), flt(rule.reward_2), flt(rule.reward_3)]
			reward_text = "+" + "–".join(f"{value:g}" for value in rewards if value) + " ₽" if any(rewards) else reward_text
		rules.append({
			"code": rule.rule_code,
			"title": rule.rule_title,
			"rewardText": reward_text,
			"reward1": flt(rule.reward_1),
			"reward2": flt(rule.reward_2),
			"reward3": flt(rule.reward_3),
			"points": flt(rule.points),
			"minimum": flt(rule.personal_minimum),
			"minimumText": f"{flt(rule.personal_minimum):g}",
			"fact": fact,
			"plan": flt(rule.team_plan),
			"status": f"Ещё {max(0, cint(rule.team_plan) - fact)}",
		})

	today = getdate()
	return {
		"ok": True,
		"generatedAt": frappe.utils.now_datetime().isoformat(),
		"updatedAt": max((str(row.computed_at) for row in results if row.computed_at), default=None),
		"updatedTime": frappe.utils.now_datetime().strftime("%H:%M"),
		"game": {
			"title": doc.title,
			"period": f"{getdate(doc.start_date).strftime('%d.%m.%Y')}–{getdate(doc.end_date).strftime('%d.%m.%Y')}",
			"periodName": doc.period_name or "",
			"startDate": str(doc.start_date),
			"endDate": str(doc.end_date),
			"daysLeft": max(0, (getdate(doc.end_date) - today).days),
			"focusName": doc.focus_name or "",
			"focusMultiplier": flt(doc.premium_multiplier),
			"pointsMultiplier": flt(doc.points_multiplier),
			"leaderBonus": flt(doc.leader_bonus),
			"teamBonusEach": flt(doc.team_bonus_each),
			"averageCheckThreshold": flt(doc.average_check_threshold),
			"rulesVersion": doc.rules_version or "",
		},
		"employees": employees,
		"rules": rules,
		"puzzle": {
			"filledPieces": cint(doc.puzzle_filled_pieces),
			"totalPieces": cint(doc.puzzle_total_pieces) or 100,
			"completed": cint(doc.puzzle_filled_pieces) >= (cint(doc.puzzle_total_pieces) or 100),
			"rewardEach": flt(doc.team_bonus_each),
		},
	}

def _employee_name_map(employee_ids):
	return {
		row.name: row.employee_name
		for row in frappe.get_all(
			"Employee",
			filters={"name": ["in", employee_ids or ["__none__"]]},
			fields=["name", "employee_name"],
			limit_page_length=1000,
		)
	}


@frappe.whitelist()
def save_schedule(business_point, month, entries=None, publish=0):
	"""Create or update a monthly schedule. Entries are [{date, employee, shift_template}]."""
	require_access("team.schedule", "write")
	_scope_point(business_point)
	month = getdate(month).replace(day=1)
	entries = frappe.parse_json(entries) if isinstance(entries, str) else (entries or [])
	name = frappe.db.get_value("Work Schedule", {"business_point": business_point, "month": month}, "name")
	doc = frappe.get_doc("Work Schedule", name) if name else frappe.new_doc("Work Schedule")
	doc.business_point = business_point
	doc.business_entity = frappe.db.get_value("Business Point", business_point, "business_entity")
	doc.month = month
	doc.entries = []
	base_templates = frappe.get_all(
		"Shift Template",
		filters={"active": 1},
		fields=["name", "shift_code", "start_time", "end_time", "paid_hours"],
		order_by="start_time asc",
		limit_page_length=2,
	)
	if len(base_templates) < 2:
		frappe.throw(_("Для графика должны быть настроены две активные смены: утро и вечер"))
	templates = {row.name: row for row in base_templates}
	allowed_employees = set(frappe.get_all(
		"Employee Point Assignment",
		filters={"business_point": business_point},
		pluck="parent",
		limit_page_length=1000,
	))
	seen_slots = set()
	for item in entries:
		work_date = getdate(item.get("date") or item.get("work_date"))
		if work_date.year != month.year or work_date.month != month.month:
			frappe.throw(_("Дата смены должна входить в выбранный месяц"))
		employee = item.get("employee")
		if employee not in allowed_employees:
			frappe.throw(_("Сотрудник не назначен на выбранную точку"))
		template = templates.get(item.get("shift_template"))
		if not template:
			frappe.throw(_("В графике можно использовать только базовые смены «утро» и «вечер»"))
		key = (str(work_date), template.name)
		if key in seen_slots:
			frappe.throw(_("На одну смену в один день можно назначить только одного сотрудника"))
		seen_slots.add(key)
		doc.append("entries", {
			"work_date": work_date,
			"employee": employee,
			"shift_template": template.name,
			"start_time": template.start_time,
			"end_time": template.end_time,
			"planned_hours": template.paid_hours,
			"notes": item.get("notes"),
		})
	if cint(publish):
		last_day = monthrange(month.year, month.month)[1]
		missing = []
		for day in range(1, last_day + 1):
			work_date = month.replace(day=day)
			for template in base_templates:
				if (str(work_date), template.name) not in seen_slots:
					missing.append(f"{day}: {template.shift_code}")
		if missing:
			frappe.throw(_("Нельзя опубликовать неполный график. Не назначены смены: {0}").format(", ".join(missing[:20])))
		doc.status = "Published"
		doc.published_at = now_datetime()
	elif not doc.status:
		doc.status = "Draft"
	doc.save(ignore_permissions=True)
	return {"name": doc.name, "status": doc.status, "entries": len(doc.entries)}


def _payroll_period_defaults(period_start=None, period_end=None):
	today = getdate()
	if period_start and period_end:
		return getdate(period_start), getdate(period_end)
	if today.day <= 15:
		return today.replace(day=1), today.replace(day=15)
	return today.replace(day=16), today.replace(day=monthrange(today.year, today.month)[1])


def _effective_payroll_components(business_point, position=None):
	entity = frappe.db.get_value("Business Point", business_point, "business_entity")
	rows = frappe.get_all(
		"Payroll Accrual Type",
		filters={
			"active": 1,
			"business_entity": entity,
			"business_point": ["in", ["", business_point]],
			"position": ["in", ["", position]] if position else "",
		},
		fields=[
			"name", "component_code", "component_name", "business_point", "position", "calculation_basis",
			"default_rate", "default_percent", "payment_method", "include_in_ndfl_base",
			"include_in_insurance_base", "include_in_injury_base",
		],
		order_by="business_point asc, position asc, component_name asc",
		limit_page_length=500,
	)
	by_code = {}
	priorities = {}
	for row in rows:
		priority = (2 if row.business_point == business_point else 0) + (1 if position and row.position == position else 0)
		if row.component_code not in by_code or priority >= priorities[row.component_code]:
			by_code[row.component_code] = row
			priorities[row.component_code] = priority
	return list(by_code.values())


def _payroll_rows(business_point, period_start, period_end):
	scope = _scope_point(business_point)
	employees = frappe.get_all(
		"Employee",
		filters=_employee_filters(scope, business_point),
		fields=["name", "employee_name", "position"],
		order_by="employee_name asc",
		limit_page_length=500,
	)
	by_employee = {row.name: row for row in employees}
	metrics = {row.name: {"hours": 0.0, "sales": 0.0} for row in employees}
	for shift in frappe.get_all(
		"Sales Shift",
		filters={
			"business_point": business_point,
			"opened_at": ["between", [f"{period_start} 00:00:00", f"{period_end} 23:59:59"]],
			"status": "Closed",
		},
		fields=["cashier", "opened_at", "closed_at", "net_sales"],
		limit_page_length=100000,
	):
		if shift.cashier not in metrics:
			continue
		metrics[shift.cashier]["hours"] += max(0, time_diff_in_hours(shift.closed_at, shift.opened_at))
		metrics[shift.cashier]["sales"] += flt(shift.net_sales)
	bonus_by_employee = {}
	period_names = frappe.get_all(
		"Motivation Period",
		filters={"business_point": business_point, "start_date": ["<=", period_end], "end_date": [">=", period_start]},
		pluck="name",
		limit_page_length=100,
	)
	if period_names:
		for result in frappe.get_all(
			"Employee Motivation Result",
			filters={"motivation_period": ["in", period_names]},
			fields=["employee", "total_bonus"],
			limit_page_length=5000,
		):
			bonus_by_employee[result.employee] = bonus_by_employee.get(result.employee, 0) + flt(result.total_bonus)
	policy_name = frappe.db.get_value("Payroll Policy", {"business_point": business_point, "active": 1}, "name")
	policy = frappe.get_doc("Payroll Policy", policy_name) if policy_name else frappe._dict(
		ndfl_rate=13, insurance_rate=30, injury_rate=0.2
	)
	rows = []
	for employee_id, metric in metrics.items():
		components = _effective_payroll_components(business_point, by_employee[employee_id].position)
		amounts = []
		for component in components:
			basis = component.calculation_basis
			if basis == "Hours":
				amount = metric["hours"] * flt(component.default_rate)
			elif basis == "Personal Sales":
				amount = metric["sales"] * flt(component.default_percent) / 100
			elif basis == "Fixed Amount":
				amount = flt(component.default_rate)
			elif basis == "External Result" and component.component_code in ("BONUS", "MOTIVATION"):
				amount = bonus_by_employee.get(employee_id, 0)
			else:
				amount = 0
			amounts.append((component, amount))
		hourly = sum(value for item, value in amounts if item.calculation_basis == "Hours")
		piecework = sum(value for item, value in amounts if item.calculation_basis == "Personal Sales")
		bonus = sum(value for item, value in amounts if item.calculation_basis == "External Result")
		other = sum(value for item, value in amounts if item.calculation_basis == "Fixed Amount")
		gross = sum(value for _, value in amounts)
		ndfl_base = sum(value for item, value in amounts if cint(item.include_in_ndfl_base))
		insurance_base = sum(value for item, value in amounts if cint(item.include_in_insurance_base))
		injury_base = sum(value for item, value in amounts if cint(item.include_in_injury_base))
		ndfl = ndfl_base * flt(policy.ndfl_rate) / 100
		insurance = insurance_base * flt(policy.insurance_rate) / 100
		injury = injury_base * flt(policy.injury_rate) / 100
		net = gross - ndfl
		bank_gross = sum(value for item, value in amounts if item.payment_method == "Bank Transfer")
		bank = net * bank_gross / gross if gross else 0
		rows.append({
			"employee": employee_id,
			"employee_name": by_employee[employee_id].employee_name,
			"hours": round(metric["hours"], 2),
			"hourly_amount": round(hourly, 2),
			"personal_sales": round(metric["sales"], 2),
			"piecework_amount": round(piecework, 2),
			"bonus": round(bonus, 2),
			"other_accruals": round(other, 2),
			"gross_amount": round(gross, 2),
			"ndfl": round(ndfl, 2),
			"insurance": round(insurance, 2),
			"injury": round(injury, 2),
			"bank_amount": round(bank, 2),
			"cash_amount": round(net - bank, 2),
			"net_amount": round(net, 2),
			"total_cost": round(gross + insurance + injury, 2),
		})
	return rows


@frappe.whitelist()
def calculate_payroll(business_point, period_start=None, period_end=None, save=0):
	require_access("team.payroll", "write" if cint(save) else "read")
	period_start, period_end = _payroll_period_defaults(period_start, period_end)
	if period_end < period_start:
		frappe.throw(_("Дата окончания периода не может быть раньше даты начала"))
	rows = _payroll_rows(business_point, period_start, period_end)
	totals = {
		"gross": round(sum(row["gross_amount"] for row in rows), 2),
		"ndfl": round(sum(row["ndfl"] for row in rows), 2),
		"net": round(sum(row["net_amount"] for row in rows), 2),
		"cost": round(sum(row["total_cost"] for row in rows), 2),
	}
	run_name = None
	if cint(save):
		run_name = frappe.db.get_value("Payroll Run", {
			"business_point": business_point,
			"period_start": period_start,
			"period_end": period_end,
		}, "name")
		doc = frappe.get_doc("Payroll Run", run_name) if run_name else frappe.new_doc("Payroll Run")
		doc.business_point = business_point
		doc.business_entity = frappe.db.get_value("Business Point", business_point, "business_entity")
		doc.period_start = period_start
		doc.period_end = period_end
		doc.run_title = f"Зарплата {period_start:%d.%m.%Y}–{period_end:%d.%m.%Y}"
		doc.status = "Calculated"
		doc.calculated_at = now_datetime()
		doc.lines = []
		for row in rows:
			doc.append("lines", {key: value for key, value in row.items() if key != "employee_name"})
		doc.total_accrued = totals["gross"]
		doc.total_ndfl = totals["ndfl"]
		doc.total_net = totals["net"]
		doc.total_cost = totals["cost"]
		doc.save(ignore_permissions=True)
		run_name = doc.name
	return {
		"name": run_name,
		"period_start": str(period_start),
		"period_end": str(period_end),
		"rows": rows,
		"totals": totals,
	}


@frappe.whitelist()
def get_hr_overview(business_point=None):
	require_access("team.hr", "read")
	scope = _scope_point(business_point)
	employee_filters = _employee_filters(scope, business_point)
	employees = frappe.get_all(
		"Employee",
		filters=employee_filters,
		fields=["name", "employee_name", "hire_date", "dismissal_date", "document_folder_url"],
		order_by="employee_name asc",
		limit_page_length=500,
	)
	names = [row.name for row in employees]
	leaves = frappe.get_all(
		"Employee Leave",
		filters={"employee": ["in", names or ["__none__"]]},
		fields=["name", "employee", "leave_type", "date_from", "date_to", "days", "status", "amount"],
		order_by="date_from desc",
		limit_page_length=500,
	)
	return {"employees": employees, "leaves": leaves, "employee_names": _employee_name_map(names)}

def _allowed_employee_entities(scope):
	return None if scope["global"] else (scope.get("business_entities") or ([scope.get("business_entity")] if scope.get("business_entity") else []))


def _assert_employee_scope(employee=None, business_entity=None):
	scope = get_scope()
	entity = business_entity
	if employee:
		entity = frappe.db.get_value("Employee", employee, "business_entity")
	allowed = _allowed_employee_entities(scope)
	if allowed is not None and entity not in allowed:
		frappe.throw(_("Сотрудник относится к недоступному юридическому лицу"), frappe.PermissionError)
	return scope


@frappe.whitelist()
def get_employee_registry(search=None, active=None):
	require_access("team.employees", "read")
	scope = get_scope()
	filters = {}
	if active not in (None, ""):
		filters["active"] = cint(active)
	allowed = _allowed_employee_entities(scope)
	if allowed is not None:
		filters["business_entity"] = ["in", allowed or ["__none__"]]
	or_filters = None
	if search:
		value = f"%{search.strip()}%"
		or_filters = {"employee_name": ["like", value], "phone": ["like", value]}
	rows = frappe.get_all(
		"Employee",
		filters=filters,
		or_filters=or_filters,
		fields=[
			"name", "employee_name", "phone", "position", "business_entity", "employment_type",
			"hire_date", "active", "system_user_profile",
		],
		order_by="employee_name asc",
		limit_page_length=1000,
	)
	profiles = {}
	profile_names = [row.system_user_profile for row in rows if row.system_user_profile]
	if profile_names:
		profiles = {
			row.name: row
			for row in frappe.get_all(
				"Raspechatka User Profile",
				filters={"name": ["in", profile_names]},
				fields=["name", "active", "access_profile", "invitation_status", "system_user"],
				limit_page_length=1000,
			)
		}
	for row in rows:
		row["access"] = profiles.get(row.system_user_profile)
	return rows


@frappe.whitelist()
def get_employee_editor(name=None):
	require_access("team.employees", "read")
	scope = get_scope()
	allowed_entities = _allowed_employee_entities(scope)
	entity_filters = {"active": 1}
	if allowed_entities is not None:
		entity_filters["name"] = ["in", allowed_entities or ["__none__"]]
	entities = frappe.get_all(
		"Business Entity",
		filters=entity_filters,
		fields=["name", "short_name", "organization"],
		order_by="short_name asc",
		limit_page_length=500,
	)
	point_filters = {"active": 1}
	if not scope["global"]:
		point_filters["name"] = ["in", scope.get("points") or ["__none__"]]
	points = frappe.get_all(
		"Business Point",
		filters=point_filters,
		fields=["name", "point_name", "business_entity"],
		order_by="point_name asc",
		limit_page_length=1000,
	)
	positions = frappe.get_all("Position", fields=["name", "position_name"], order_by="position_name asc", limit_page_length=500)
	result = {"employee": None, "entities": entities, "points": points, "positions": positions, "access": None}
	if name:
		_assert_employee_scope(employee=name)
		doc = frappe.get_doc("Employee", name)
		result["employee"] = doc.as_dict(no_nulls=False)
		if doc.system_user_profile:
			profile = frappe.get_doc("Raspechatka User Profile", doc.system_user_profile)
			result["access"] = {
				"name": profile.name,
				"active": profile.active,
				"access_profile": profile.access_profile,
				"invitation_status": profile.invitation_status,
				"invited_at": profile.invited_at,
				"system_user": profile.system_user,
				"assigned_points": [row.as_dict() for row in profile.assigned_points],
			}
	return result


@frappe.whitelist(methods=["POST"])
def save_employee(data):
	require_access("team.employees", "write")
	data = frappe.parse_json(data)
	name = data.get("name")
	if name:
		_assert_employee_scope(employee=name)
	_assert_employee_scope(business_entity=data.get("business_entity"))
	doc = frappe.get_doc("Employee", name) if name else frappe.new_doc("Employee")
	for fieldname in (
		"active", "last_name", "first_name", "middle_name", "birth_date", "gender", "phone", "email",
		"business_entity", "position", "employment_type", "hire_date", "dismissal_date", "inn", "snils",
		"registration_address", "disability", "hazardous_conditions",
		"medical_exam_required", "document_folder_url", "notes",
		"passport_issue_date", "passport_issued_by", "passport_department_code",
		"passport_main_file", "passport_registration_file", "salary_bank_name", "salary_bic",
		"salary_correspondent_account", "salary_account", "salary_recipient_name",
	):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	# Password fields are masked when the card is loaded. Never overwrite the
	# encrypted value with asterisks during an unrelated edit.
	for fieldname in ("passport_series", "passport_number"):
		value = data.get(fieldname)
		if value is not None and str(value).strip() and set(str(value).strip()) != {"*"}:
			doc.set(fieldname, digits(value))
	scope = get_scope()
	allowed_points = None if scope["global"] else set(scope.get("points") or [])
	doc.set("assigned_points", [])
	seen = set()
	for row in data.get("assigned_points") or []:
		point = row.get("business_point")
		if not point or point in seen:
			continue
		if allowed_points is not None and point not in allowed_points:
			frappe.throw(_("Нельзя назначить сотруднику недоступную точку"), frappe.PermissionError)
		if frappe.db.get_value("Business Point", point, "business_entity") != doc.business_entity:
			frappe.throw(_("Точка сотрудника должна относиться к его работодателю"))
		seen.add(point)
		doc.append("assigned_points", {"business_point": point, "is_default": cint(row.get("is_default"))})
	if sum(cint(row.is_default) for row in doc.assigned_points) > 1:
		frappe.throw(_("Основной может быть только одна точка"))
	if doc.assigned_points and not any(cint(row.is_default) for row in doc.assigned_points):
		doc.assigned_points[0].is_default = 1
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def grant_employee_access(employee, access_profile="Cashier", assigned_points=None):
	require_access("team.employees", "write")
	scope = _assert_employee_scope(employee=employee)
	if access_profile not in ("Cashier", "Point Manager"):
		frappe.throw(_("Из карточки сотрудника можно выдать только доступ кассира или управляющего"))
	employee_doc = frappe.get_doc("Employee", employee)
	points = frappe.parse_json(assigned_points) if isinstance(assigned_points, str) else (assigned_points or [])
	points = list(dict.fromkeys(points))
	employee_points = {row.business_point for row in employee_doc.assigned_points}
	allowed_points = employee_points if scope["global"] else employee_points.intersection(scope.get("points") or [])
	if not points or any(point not in allowed_points for point in points):
		frappe.throw(_("Выберите только точки, назначенные этому сотруднику"))
	profile_name = employee_doc.system_user_profile
	profile = frappe.get_doc("Raspechatka User Profile", profile_name) if profile_name else frappe.new_doc("Raspechatka User Profile")
	profile.active = 1
	profile.last_name = employee_doc.last_name
	profile.first_name = employee_doc.first_name
	profile.middle_name = employee_doc.middle_name
	profile.phone = employee_doc.phone
	profile.access_profile = access_profile
	profile.scope_type = "Points"
	profile.business_entity = employee_doc.business_entity
	profile.organization = frappe.db.get_value("Business Entity", employee_doc.business_entity, "organization")
	profile.linked_employee = employee_doc.name
	profile.set("assigned_points", [])
	for index, point in enumerate(points):
		profile.append("assigned_points", {"business_point": point, "is_default": 1 if index == 0 else 0})
	profile.save(ignore_permissions=True)
	if employee_doc.system_user_profile != profile.name:
		frappe.db.set_value("Employee", employee_doc.name, "system_user_profile", profile.name, update_modified=False)
	profile.reload()
	user = frappe.get_doc("User", profile.system_user)
	link = user._reset_password(send_email=False, password_expired=True)
	frappe.db.set_value(
		"Raspechatka User Profile",
		profile.name,
		{"invitation_status": "Generated", "invited_at": now_datetime()},
		update_modified=True,
	)
	message = _(
		"Вам предоставлен доступ к системе «Распечатка ОС».\n"
		"Ссылка для входа: {0}/login\n"
		"Логин: {1}\n"
		"Чтобы установить пароль, перейдите по одноразовой ссылке: {2}\n"
		"После установки пароля используйте номер телефона как логин."
	).format(get_url(), profile.phone, link)
	return {"profile": profile.name, "login": profile.phone, "link": link, "message": message}


@frappe.whitelist(methods=["POST"])
def set_employee_access_active(employee, active):
	require_access("team.employees", "write")
	_assert_employee_scope(employee=employee)
	profile_name = frappe.db.get_value("Employee", employee, "system_user_profile")
	if not profile_name:
		frappe.throw(_("Доступ сотруднику ещё не выдавался"))
	profile = frappe.get_doc("Raspechatka User Profile", profile_name)
	profile.active = cint(active)
	profile.save(ignore_permissions=True)
	if not profile.active and profile.system_user:
		frappe.db.delete("Sessions", {"user": profile.system_user})
	return {"profile": profile.name, "active": profile.active}

@frappe.whitelist()
def get_payroll_settings_options():
	require_access("team.payroll", "read")
	scope = get_scope()
	return frappe.get_all(
		"Business Point",
		filters=_point_filters(scope),
		fields=["name", "point_name", "business_entity"],
		order_by="point_name asc",
		limit_page_length=500,
	)


@frappe.whitelist()
def get_payroll_settings(business_point, position=None):
	require_access("team.payroll", "read")
	_scope_point(business_point)
	entity = frappe.db.get_value("Business Point", business_point, "business_entity")
	policy_name = frappe.db.get_value("Payroll Policy", {"business_point": business_point}, "name")
	policy = frappe.get_doc("Payroll Policy", policy_name).as_dict(no_nulls=False) if policy_name else {
		"business_point": business_point, "business_entity": entity, "ndfl_rate": 13,
		"insurance_rate": 30, "injury_rate": 0.2, "annual_leave_days": 28,
		"first_half_pay_day": 20, "second_half_pay_day": 5, "active": 1,
	}
	positions = frappe.get_all(
		"Position", fields=["name", "position_name"], order_by="position_name asc", limit_page_length=500
	)
	component_filters = {"business_entity": entity, "business_point": business_point}
	if position:
		component_filters["position"] = position
	components = frappe.get_all(
		"Payroll Accrual Type",
		filters=component_filters,
		fields=[
			"name", "component_code", "component_name", "active", "position", "calculation_basis",
			"default_rate", "default_percent", "payment_method", "include_in_ndfl_base",
			"include_in_insurance_base", "include_in_injury_base", "exemption_basis", "notes",
		],
		order_by="component_name asc",
		limit_page_length=500,
	)
	return {"policy": policy, "components": components, "positions": positions}


@frappe.whitelist(methods=["POST"])
def save_payroll_policy(data):
	require_access("team.payroll", "write")
	data = frappe.parse_json(data)
	point = data.get("business_point")
	_scope_point(point)
	name = frappe.db.get_value("Payroll Policy", {"business_point": point}, "name")
	doc = frappe.get_doc("Payroll Policy", name) if name else frappe.new_doc("Payroll Policy")
	doc.business_point = point
	doc.business_entity = frappe.db.get_value("Business Point", point, "business_entity")
	for fieldname in ("ndfl_rate", "insurance_rate", "injury_rate", "annual_leave_days", "first_half_pay_day", "second_half_pay_day", "active"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_payroll_component(data):
	require_access("team.payroll", "write")
	data = frappe.parse_json(data)
	point = data.get("business_point")
	_scope_point(point)
	entity = frappe.db.get_value("Business Point", point, "business_entity")
	name = data.get("name")
	if name:
		doc = frappe.get_doc("Payroll Accrual Type", name)
		if doc.business_point != point:
			frappe.throw(_("Нельзя изменить настройку другой точки"), frappe.PermissionError)
	else:
		doc = frappe.new_doc("Payroll Accrual Type")
	doc.business_point = point
	doc.business_entity = entity
	doc.position = data.get("position")
	if not doc.position:
		frappe.throw(_("Выберите должность для начисления"))
	for fieldname in (
		"component_code", "component_name", "active", "calculation_basis", "default_rate",
		"default_percent", "payment_method", "include_in_ndfl_base", "include_in_insurance_base",
		"include_in_injury_base", "exemption_basis", "notes",
	):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def create_default_payroll_components(business_point, position):
	require_access("team.payroll", "write")
	_scope_point(business_point)
	entity = frappe.db.get_value("Business Point", business_point, "business_entity")
	if not position or not frappe.db.exists("Position", position):
		frappe.throw(_("Выберите существующую должность"))
	defaults = [
		("HOURLY", "Оплата за часы", "Hours", 200, 0, "Bank Transfer", 1, 1, 1),
		("SALES_PERCENT", "Процент от личной выручки", "Personal Sales", 0, 5, "Bank Transfer", 1, 1, 1),
		("MOTIVATION", "Премия за результаты", "External Result", 0, 0, "Cash", 1, 1, 1),
		("OTHER", "Другие начисления", "Manual", 0, 0, "Cash", 1, 1, 1),
	]
	created = 0
	for code, title, basis, rate, percent, payment, ndfl, insurance, injury in defaults:
		if frappe.db.exists("Payroll Accrual Type", {"business_entity": entity, "business_point": business_point, "position": position, "component_code": code}):
			continue
		frappe.get_doc({
			"doctype": "Payroll Accrual Type", "component_code": code, "component_name": title,
			"active": 1, "business_entity": entity, "business_point": business_point, "position": position,
			"calculation_basis": basis, "default_rate": rate, "default_percent": percent,
			"payment_method": payment, "include_in_ndfl_base": ndfl,
			"include_in_insurance_base": insurance, "include_in_injury_base": injury,
		}).insert(ignore_permissions=True)
		created += 1
	return {"created": created}

