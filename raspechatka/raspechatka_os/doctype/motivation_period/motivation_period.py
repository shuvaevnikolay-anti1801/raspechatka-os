import hashlib
import json

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate


class MotivationPeriod(Document):
	def validate(self):
		if getdate(self.end_date) < getdate(self.start_date):
			frappe.throw(_("Дата окончания не может быть раньше даты начала"))
		self.business_entity = frappe.db.get_value("Business Point", self.business_point, "business_entity")
		codes = [row.rule_code for row in self.rules]
		if len(codes) != len(set(codes)):
			frappe.throw(_("Каждое действие можно добавить в правила только один раз"))
		if self.status == "Active":
			overlapping = frappe.db.exists(
				"Motivation Period",
				{
					"name": ["!=", self.name],
					"business_point": self.business_point,
					"status": "Active",
					"start_date": ["<=", self.end_date],
					"end_date": [">=", self.start_date],
				},
			)
			if overlapping:
				frappe.throw(_("На одной точке не может быть двух активных игр с пересекающимися датами"))

		payload = {
			"focus": self.focus_code,
			"premium_multiplier": self.premium_multiplier,
			"points_multiplier": self.points_multiplier,
			"leader_bonus": self.leader_bonus,
			"team_bonus_each": self.team_bonus_each,
			"team_logic": self.team_logic,
			"threshold": self.average_check_threshold,
			"rules": [
				{
					"code": row.rule_code,
					"reward": row.reward,
					"reward_1": row.reward_1,
					"reward_2": row.reward_2,
					"reward_3": row.reward_3,
					"points": row.points,
					"minimum": row.personal_minimum,
					"plan": row.team_plan,
				}
				for row in self.rules
			],
		}
		serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
		self.rules_version = hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:12]

