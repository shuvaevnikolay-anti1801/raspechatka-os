import frappe
from frappe.utils import flt


def execute():
	"""Move the legacy point value only when it is unambiguous; otherwise fail closed."""
	if not frappe.db.has_column("POS Sales Settings", "review_discount_per_review"):
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
			"У активных точек были разные скидки за отзыв. Сетевая настройка безопасно установлена в 0; задайте её явно.",
			"POS review discount migration",
		)
