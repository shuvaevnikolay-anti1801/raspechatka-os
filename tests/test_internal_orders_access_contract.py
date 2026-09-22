import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_internal_orders_registry_is_unique_under_warehouse_and_deny_by_default():
	registry = json.loads((ROOT / "frontend/src/access-pages.json").read_text(encoding="utf-8"))
	warehouse = next(section for section in registry if section["key"] == "warehouse")
	pages = [
		page
		for page in warehouse["pages"]
		if page["area"] == "page.warehouse.internal_orders"
	]
	assert len(pages) == 1
	page = pages[0]
	assert page["label"] == "Внутренние заказы"
	assert page["route"] == "/warehouse/internal-orders"
	assert "legacy_area" not in page


def test_internal_orders_api_is_read_only_and_declares_point_scoped_view_access():
	source = (ROOT / "raspechatka/api/internal_orders.py").read_text(encoding="utf-8")
	contract = '@access_contract(area="page.warehouse.internal_orders", action="read", scope="point")'
	assert source.count("@frappe.whitelist()") == 2
	assert source.count(contract) == 2
	assert source.count('require_access(AREA, "read")') == 2
	assert "from raspechatka.scope import point_filter" in source
	for forbidden in ("insert(", ".save(", "delete_doc(", "db.set_value("):
		assert forbidden not in source
