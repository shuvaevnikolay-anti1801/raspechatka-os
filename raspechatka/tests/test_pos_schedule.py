from types import SimpleNamespace
from unittest.mock import patch

from raspechatka.api import pos


def test_schedule_month_current_and_next_use_calendar_months():
	with (
		patch.object(pos, "nowdate", return_value="2026-09-23"),
		patch.object(pos, "_schedule_rows", return_value=[]) as schedule_rows,
		patch.object(pos, "_schedule_employees", return_value=[]),
	):
		current = pos._get_schedule_month("POINT-1")
		next_month = pos._get_schedule_month("POINT-1", pos._schedule_month_value(1))

	assert current == {"month": "2026-09", "days": 30, "employees": [], "entries": []}
	assert next_month == {"month": "2026-10", "days": 31, "employees": [], "entries": []}
	assert [call.kwargs["month"] for call in schedule_rows.call_args_list] == ["2026-09-01", "2026-10-01"]


def test_schedule_month_value_rolls_december_into_next_year():
	with patch.object(pos, "nowdate", return_value="2026-12-15"):
		assert pos._schedule_month_value() == "2026-12-01"
		assert pos._schedule_month_value(1) == "2027-01-01"


def test_workplace_data_exposes_current_alias_and_empty_next_month():
	employee = SimpleNamespace(name="EMP-1")
	point = SimpleNamespace(name="POINT-1")
	workplace = SimpleNamespace(name="POS-1")
	with (
		patch.object(pos, "nowdate", return_value="2026-12-15"),
		patch.object(pos, "_schedule_rows", return_value=[]),
		patch.object(pos, "_schedule_employees", return_value=[]),
		patch.object(pos, "_get_employee_schedule", return_value=[]),
		patch.object(pos, "_get_upcoming_shifts", return_value=[]),
		patch.object(pos, "_get_operational_catalog", return_value=[]),
		patch.object(pos, "_get_delivery_notices", return_value=[]),
		patch.object(pos, "_get_supply_requests", return_value=[]),
		patch.object(pos, "_get_cleaner_status", return_value={}),
		patch.object(pos, "_get_orders", return_value=[]),
	):
		data = pos._get_workplace_data(employee, point, workplace)

	assert data["scheduleMonth"] == data["scheduleCurrentMonth"]
	assert data["scheduleCurrentMonth"]["month"] == "2026-12"
	assert data["scheduleNextMonth"] == {
		"month": "2027-01",
		"days": 31,
		"employees": [],
		"entries": [],
	}
