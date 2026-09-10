from time import perf_counter

import frappe
from frappe.utils import cint, now_datetime

from raspechatka.stock import effective_ledger_condition


@frappe.whitelist()
def get_stock_query_plan():
	"""Return safe EXPLAIN output for the main warehouse read paths."""
	frappe.only_for("System Manager")
	warehouse = frappe.db.get_value("Catalog Warehouse", {"active": 1}, "name")
	item = frappe.db.get_value("Stock Balance", {"warehouse": warehouse}, "item") if warehouse else None
	if not warehouse:
		return {"warehouse": None, "plans": {}, "message": "Нет активного склада для анализа."}

	queries = _diagnostic_queries(warehouse, item)
	return {
		"warehouse": warehouse,
		"item": item,
		"ledger_rows": frappe.db.count("Stock Ledger Entry"),
		"balance_rows": frappe.db.count("Stock Balance"),
		"plans": {
			name: frappe.db.sql(f"explain {query}", values, as_dict=True)
			for name, (query, values) in queries.items()
		},
	}


@frappe.whitelist(methods=["POST"])
def benchmark_stock_reads(iterations=3):
	"""Measure warehouse reads without creating or changing business data."""
	frappe.only_for("System Manager")
	iterations = min(max(cint(iterations or 3), 1), 10)
	warehouse = frappe.db.get_value("Catalog Warehouse", {"active": 1}, "name")
	item = frappe.db.get_value("Stock Balance", {"warehouse": warehouse}, "item") if warehouse else None
	if not warehouse:
		return {"warehouse": None, "results": {}, "message": "Нет активного склада для замера."}

	results = {}
	for name, (query, values) in _diagnostic_queries(warehouse, item).items():
		durations = []
		row_count = 0
		for _iteration in range(iterations):
			started = perf_counter()
			rows = frappe.db.sql(query, values, as_dict=True)
			durations.append((perf_counter() - started) * 1000)
			row_count = len(rows)
		results[name] = {
			"runs": iterations,
			"rows": row_count,
			"minimum_ms": round(min(durations), 2),
			"average_ms": round(sum(durations) / len(durations), 2),
			"maximum_ms": round(max(durations), 2),
		}
	return {
		"warehouse": warehouse,
		"item": item,
		"measured_at": now_datetime(),
		"results": results,
	}


def _diagnostic_queries(warehouse, item=None):
	condition = effective_ledger_condition(alias="")
	queries = {
		"movement_page": (
			f"""select name, posting_datetime, item, actual_qty
			from `tabStock Ledger Entry`
			where warehouse = %s and posting_datetime <= %s and {condition}
			order by posting_datetime desc, creation desc limit 100""",
			(warehouse, now_datetime()),
		),
		"historical_totals": (
			f"""select item, warehouse, sum(actual_qty), sum(stock_value_difference)
			from `tabStock Ledger Entry`
			where warehouse = %s and posting_datetime <= %s and {condition}
			group by item, warehouse""",
			(warehouse, now_datetime()),
		),
	}
	if item:
		queries["current_balance"] = (
			"""select actual_qty, stock_value, average_rate
			from `tabStock Balance` where warehouse = %s and item = %s limit 1""",
			(warehouse, item),
		)
	return queries
