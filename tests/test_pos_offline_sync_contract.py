from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_pos_bootstrap_mirrors_only_authenticated_connection_point():
	source = (ROOT / "raspechatka/api/pos_v2.py").read_text(encoding="utf-8")
	bootstrap = source[source.index("def get_bootstrap") : source.index("def _allocate_final_amounts")]
	assert "connection.business_point" in bootstrap
	assert '"customers": _customers()' in bootstrap
	assert '"receiptMirror": _receipt_mirror(point.name)' in bootstrap
	assert '"retentionDays": POS_MIRROR_RETENTION_DAYS' in bootstrap
	receipts = source[source.index("def _receipt_mirror") : source.index("def _rules")]
	assert '"business_point": point_name' in receipts
	assert "add_days(now_datetime(), -POS_MIRROR_RETENTION_DAYS)" in receipts


def test_pos_employee_allowlist_remains_active_and_point_scoped():
	source = (ROOT / "raspechatka/api/pos_device.py").read_text(encoding="utf-8")
	section = source[source.index("def _point_employees") : source.index("def _customers")]
	assert '"business_point": point_name' in section
	assert '"active": 1' in section
	assert '"enabled": 1' in section
	assert '"access_profile": "Raspechatka Cashier"' in section


def test_receipt_search_keeps_pos_connection_point_authoritative():
	source = (ROOT / "raspechatka/api/receipt_search.py").read_text(encoding="utf-8")
	section = source[source.index("def search_receipts") :]
	assert "point = connection.business_point" in section
	assert '["Sales Receipt", "business_point", "=", point]' in section


def test_sync_fetches_large_master_data_only_once_per_cycle():
	source = (ROOT / "pos/src/main/sync.ts").read_text(encoding="utf-8")
	perform_sync = source[
		source.index("export async function performSync") : source.index("export function startAutomaticSync")
	]
	assert perform_sync.count("await applyBootstrap()") == 1
