from calendar import monthrange
from datetime import date

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate

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

	return {
		"month": str(month),
		"points": points,
		"employees": employees,
		"schedules": schedules,
		"motivation_periods": motivation,
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
	return {
		"name": doc.name,
		"business_point": doc.business_point,
		"month": str(doc.month),
		"status": doc.status,
		"days": monthrange(month.year, month.month)[1],
		"entries": [
			{
				"date": str(row.work_date),
				"employee": row.employee,
				"shift_template": row.shift_template,
				"start_time": str(row.start_time or ""),
				"end_time": str(row.end_time or ""),
				"planned_hours": flt(row.planned_hours),
			}
			for row in doc.entries
		],
	}


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
