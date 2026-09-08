from calendar import monthrange
from datetime import date

import frappe
from frappe import _
from frappe.utils import cint, flt, get_datetime, getdate, now_datetime, time_diff_in_hours

from raspechatka.access import get_scope, require_access


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
	seen = set()
	for item in entries:
		work_date = getdate(item.get("date") or item.get("work_date"))
		if work_date.year != month.year or work_date.month != month.month:
			frappe.throw(_("Дата смены должна входить в выбранный месяц"))
		key = (str(work_date), item.get("employee"))
		if key in seen:
			frappe.throw(_("У сотрудника не может быть две плановые смены в один день"))
		seen.add(key)
		template = frappe.get_doc("Shift Template", item.get("shift_template"))
		doc.append("entries", {
			"work_date": work_date,
			"employee": item.get("employee"),
			"shift_template": template.name,
			"start_time": template.start_time,
			"end_time": template.end_time,
			"planned_hours": template.paid_hours,
			"notes": item.get("notes"),
		})
	if cint(publish):
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


def _payroll_rows(business_point, period_start, period_end):
	scope = _scope_point(business_point)
	employees = frappe.get_all(
		"Employee",
		filters=_employee_filters(scope, business_point),
		fields=[
			"name", "employee_name", "hourly_rate", "sales_percent", "ndfl_rate",
			"insurance_rate", "injury_rate", "bank_payment_share", "other_accruals_default",
		],
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
		filters={
			"business_point": business_point,
			"start_date": ["<=", period_end],
			"end_date": [">=", period_start],
		},
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
	rows = []
	for employee_id, metric in metrics.items():
		employee = by_employee[employee_id]
		hourly = metric["hours"] * flt(employee.hourly_rate)
		piecework = metric["sales"] * flt(employee.sales_percent) / 100
		bonus = bonus_by_employee.get(employee_id, 0)
		other = flt(employee.other_accruals_default)
		taxable = hourly + piecework
		gross = taxable + bonus + other
		ndfl = taxable * flt(employee.ndfl_rate) / 100
		insurance = taxable * flt(employee.insurance_rate) / 100
		injury = taxable * flt(employee.injury_rate) / 100
		net = gross - ndfl
		bank = net * flt(employee.bank_payment_share) / 100
		rows.append({
			"employee": employee_id,
			"employee_name": employee.employee_name,
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

