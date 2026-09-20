from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from raspechatka.api import pos as pos_api


def _row(index, date):
	return SimpleNamespace(
		name=f"entry-{index}",
		work_date=date,
		employee="EMP-1",
		employee_name="Иван",
		shift_template="SHIFT-U",
		shift_code="U",
		shift_name="Утренняя",
		entry_start_time="09:00:00",
		template_start_time="09:00:00",
		entry_end_time="18:00:00",
		template_end_time="18:00:00",
		entry_planned_hours=8,
		template_paid_hours=8,
	)


class TestPosWorkplaceScheduleContract(TestCase):
	@patch.object(pos_api, "_doctype_exists", return_value=True)
	@patch.object(pos_api.frappe.db, "sql", return_value=[])
	def test_month_query_is_point_scoped_published_and_month_bounded(self, sql, _exists):
		pos_api._schedule_rows("POINT-A", month="2026-09-01")
		query, values = sql.call_args.args
		self.assertIn("assignment.business_point=%s", query)
		self.assertIn("schedule.business_point=%s", query)
		self.assertIn("schedule.status='Published'", query)
		self.assertIn("schedule.month=%s", query)
		self.assertEqual(values, ["POINT-A", "POINT-A", "2026-09-01", "2026-09-01", "2026-09-30"])

	@patch.object(pos_api, "_schedule_month_value", return_value="2026-09-01")
	@patch.object(pos_api, "_schedule_employees", return_value=[])
	@patch.object(pos_api, "_schedule_rows", return_value=[])
	def test_schedule_month_is_current_month_only(self, rows, _employees, _month):
		result = pos_api._get_schedule_month("POINT-A")
		rows.assert_called_once_with("POINT-A", month="2026-09-01")
		self.assertEqual(result["month"], "2026-09")
		self.assertEqual(result["days"], 30)

	@patch.object(
		pos_api,
		"_schedule_rows",
		return_value=[
			_row(1, "2026-09-29"),
			_row(2, "2026-10-01"),
			_row(3, "2026-10-03"),
			_row(4, "2026-10-05"),
			_row(5, "2026-11-01"),
		],
	)
	def test_upcoming_five_may_cross_months(self, rows):
		result = pos_api._get_upcoming_shifts(SimpleNamespace(name="EMP-1"), "POINT-A")
		rows.assert_called_once_with("POINT-A", employee_name="EMP-1", upcoming=True, limit=5)
		self.assertEqual(len(result), 5)
		self.assertEqual(result[-1]["date"], "2026-11-01")
