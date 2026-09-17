from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_pos_reads_operational_stock_balance():
	source = (ROOT / "raspechatka/api/pos.py").read_text(encoding="utf-8")
	section = source[source.index("def _get_products") : source.index("def _get_customers")]
	assert '"Stock Balance"' in section
	assert "sum(actual_qty)" not in section


def test_finance_inventory_value_has_no_row_limit():
	source = (ROOT / "raspechatka/api/finance.py").read_text(encoding="utf-8")
	section = source[source.index("def _inventory_value") : source.index("def _link_plan")]
	assert "sum(stock_value_difference)" in section
	assert "100000" not in section


def test_large_ledger_reports_are_aggregated_by_database():
	source = (ROOT / "raspechatka/api/warehouse_reports.py").read_text(encoding="utf-8")
	assert "def _turnover_totals" in source
	assert "group by item, warehouse" in source
	assert "def _ledger_entries" not in source


def test_stock_performance_patch_is_registered():
	patches = (ROOT / "raspechatka/patches.txt").read_text(encoding="utf-8")
	assert "raspechatka.patches.v1_0.add_stock_performance_indexes" in patches
