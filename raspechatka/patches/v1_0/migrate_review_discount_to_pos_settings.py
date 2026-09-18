import frappe
from frappe.utils import flt


def execute():
	"""Move the legacy point value only when it is unambiguous; otherwise fail closed."""
	pos_settings_meta = frappe.get_meta("POS Sales Settings")
	if not pos_settings_meta.has_field("review_discount_per_review"):
		return

	business_point_meta = frappe.get_meta("Business Point")
	if not business_point_meta.has_field("review_discount_per_review"):
		return

	values = {
		flt(row.review_discount_per_review)
		for row in frappe.get_all(
			"Business Point",
			filters={"active": 1},
			fields=["review_discount_per_review"],
		)
	}
	has_conflict = len(values) > 1
	value = next(iter(values)) if len(values) == 1 else 0
	frappe.db.set_single_value("POS Sales Settings", "review_discount_per_review", value)
	if has_conflict:
		frappe.log_error(
			"Active points had conflicting review discounts. Network setting was safely reset to 0.",
			"POS review discount migration",
		)
