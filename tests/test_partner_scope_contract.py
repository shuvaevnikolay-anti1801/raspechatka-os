from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_scope_consumers_do_not_assume_one_business_entity():
	consumers = (
		"raspechatka/api/sales.py",
		"raspechatka/api/team.py",
		"raspechatka/api/frontend.py",
		"raspechatka/api/list_filters.py",
		"raspechatka/api/tochka.py",
		"raspechatka/api/warehouse.py",
		"raspechatka/api/references.py",
	)
	for path in consumers:
		source = (ROOT / path).read_text(encoding="utf-8")
		assert 'scope["business_entity"]' not in source, path


def test_sales_lists_details_options_aggregates_and_mutations_share_scope_guards():
	source = (ROOT / "raspechatka/api/sales.py").read_text(encoding="utf-8")
	assert "get_allowed_entities(scope)" in source
	assert 'filters["business_point"] = ["in", scope["points"] or ["__none__"]]' in source
	assert "_ensure_point(doc.business_point, doc.business_entity)" in source
	assert "_ensure_point(business_point)" in source
	for endpoint in (
		"get_points_overview",
		"get_shifts",
		"get_shift",
		"get_receipts",
		"get_receipt",
		"get_cash_movements",
		"get_cashier_actions",
		"get_connections",
		"provision_connection",
	):
		assert f"def {endpoint}" in source


def test_team_employee_entity_scope_and_point_owned_features_are_separate():
	source = (ROOT / "raspechatka/api/team.py").read_text(encoding="utf-8")
	assert 'filters["business_entity"] = ["in", get_allowed_entities(scope) or ["__none__"]]' in source
	assert (
		'payroll_filters["business_entity"] = ["in", get_allowed_entities(scope) or ["__none__"]]' in source
	)
	assert '"name": ["in", scope["points"] or ["__none__"]]' in source
	for endpoint in ("get_team_overview", "get_schedule", "get_hr_overview", "get_payroll_settings"):
		assert f"def {endpoint}" in source


def test_audited_reference_and_supplier_options_use_allowed_entity_set():
	for path in (
		"raspechatka/api/frontend.py",
		"raspechatka/api/list_filters.py",
		"raspechatka/api/tochka.py",
		"raspechatka/api/warehouse.py",
		"raspechatka/api/references.py",
	):
		source = (ROOT / path).read_text(encoding="utf-8")
		assert "get_allowed_entities" in source, path
