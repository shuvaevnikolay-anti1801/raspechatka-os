import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate, now_datetime


class WorkSchedule(Document):
	def validate(self):
		month = getdate(self.month).replace(day=1)
		self.month = month
		self.business_entity = frappe.db.get_value("Business Point", self.business_point, "business_entity")
		self.schedule_title = f"{self.business_point} — {month.strftime('%m.%Y')}"
		duplicate = frappe.db.exists(
			"Work Schedule",
			{"business_point": self.business_point, "month": month, "name": ["!=", self.name]},
		)
		if duplicate:
			frappe.throw(_("Для этой точки и месяца график уже существует"))

		seen = set()
		for row in self.entries:
			work_date = getdate(row.work_date)
			if work_date.year != month.year or work_date.month != month.month:
				frappe.throw(_("Все строки графика должны относиться к выбранному месяцу"))
			key = (str(work_date), row.shift_template, row.employee)
			if key in seen:
				frappe.throw(_("Нельзя дважды назначить сотруднику одну и ту же смену на одну дату"))
			seen.add(key)
			if not frappe.db.exists(
				"Employee Point Assignment",
				{"parent": row.employee, "business_point": self.business_point},
			):
				frappe.throw(_("Сотрудник не назначен на выбранную точку"))
			start_time, end_time, paid_hours = frappe.db.get_value(
				"Shift Template", row.shift_template, ["start_time", "end_time", "paid_hours"]
			)
			row.start_time = row.start_time or start_time
			row.end_time = row.end_time or end_time
			row.planned_hours = row.planned_hours or paid_hours

		if self.status == "Published" and not self.published_at:
			self.published_at = now_datetime()
