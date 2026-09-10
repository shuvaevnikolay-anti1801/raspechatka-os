import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HISTORY = (ROOT / "raspechatka/api/moysklad_stock_history.py").read_text(encoding="utf-8")
STOCK = (ROOT / "raspechatka/stock.py").read_text(encoding="utf-8")
SALE = (ROOT / "raspechatka/raspechatka_os/doctype/sales_receipt/sales_receipt.py").read_text(
	encoding="utf-8"
)
WRITE_OFF = (ROOT / "raspechatka/raspechatka_os/doctype/stock_write_off/stock_write_off.py").read_text(
	encoding="utf-8"
)
INVENTORY_ITEM = json.loads(
	(ROOT / "raspechatka/raspechatka_os/doctype/stock_inventory_item/stock_inventory_item.json").read_text(
		encoding="utf-8"
	)
)


def _section(source, start, end):
	return source[source.index(start) : source.index(end, source.index(start))]


def test_opening_positive_quantity_is_imported():
	section = _section(HISTORY, "def _create_opening_documents", "def _stock_at_moment")
	assert '"counted_quantity": quantity' in section
	assert "quantity > 0" not in section


def test_opening_negative_quantity_is_imported():
	section = _section(HISTORY, "def _create_opening_documents", "def _stock_at_moment")
	assert "if abs(quantity) <= 0.000001" in section
	counted = next(field for field in INVENTORY_ITEM["fields"] if field["fieldname"] == "counted_quantity")
	assert "non_negative" not in counted


def test_sale_from_zero_can_create_negative_balance():
	assert 'qty_after = flt(warehouse_balance["qty"]) + quantity' in STOCK
	assert "qty_after <" not in STOCK


def test_write_off_can_create_negative_balance():
	assert "requested_total" not in WRITE_OFF
	assert "Недостаточно" not in WRITE_OFF


def test_product_sale_creates_outgoing_movement():
	section = _section(SALE, "def _create_stock_entries", "def _get_original_rate")
	assert 'sign = -1 if self.receipt_type == "Sale" else 1' in section
	assert 'item.item_type not in {"Product", "Variant"}' in section


def test_product_return_creates_incoming_movement():
	section = _section(SALE, "def _create_stock_entries", "def _get_original_rate")
	assert 'sign = -1 if self.receipt_type == "Sale" else 1' in section


def test_service_has_no_stock_movement():
	section = _section(SALE, "def _prepare_consumed_materials", "def _returned_materials")
	assert 'if item_type == "Service":' in section
	assert "continue" in section


def test_service_recipe_is_not_expanded():
	assert "def _service_materials" not in SALE
	assert '"Catalog Recipe Component"' not in SALE


def test_bundle_uses_stock_components():
	section = _section(SALE, "def _bundle_materials", "def _merge_materials")
	assert 'component_type in {"Product", "Variant"} and track_inventory' in section
	assert '"source_type": "Bundle"' in section


def test_service_inside_bundle_is_skipped():
	section = _section(SALE, "def _bundle_materials", "def _merge_materials")
	assert 'component_type in {"Product", "Variant"} and track_inventory' in section


def test_bundle_return_uses_frozen_original_composition():
	prepare = _section(SALE, "def _prepare_consumed_materials", "def _returned_materials")
	returned = _section(SALE, "def _returned_materials", "def _bundle_materials")
	assert 'self.receipt_type == "Return" and item_type == "Bundle"' in prepare
	assert '"Sales Receipt Material"' in returned
	assert '"source_type": "Original Sale"' in returned


def test_target_events_share_one_chronological_stream():
	run = _section(HISTORY, "def run_stock_history_import", "def _assert_safe_first_import")
	assert "events.extend(_sales_receipt_events())" in run
	assert 'events.sort(key=lambda row: (get_datetime(row["moment"]), row["priority"], row["key"]))' in run


def test_repeat_run_is_idempotent():
	stock_doc = _section(HISTORY, "def _import_stock_document", "def _mapped_warehouse")
	backfill = _section(HISTORY, "def _backfill_sales_stock", "def _catalog_buy_rate")
	assert 'frappe.db.exists(doctype, {"external_id": external_id})' in stock_doc
	assert '"Stock Ledger Entry", {"voucher_type": "Sales Receipt", "voucher_no": name}' in backfill
	assert 'stats["sales_stock_duplicates"]' in backfill


def test_stock_movements_are_never_deleted_by_history_import():
	assert 'frappe.delete_doc("Stock Ledger Entry"' not in HISTORY
	assert 'frappe.db.delete("Stock Ledger Entry"' not in HISTORY


def test_destructive_rebuild_endpoint_is_not_exposed():
	assert "start_stock_history_rebuild" not in HISTORY
	assert "_reset_initial_history" not in HISTORY


def test_excluded_source_document_types_are_not_imported_or_audited():
	constants = HISTORY[: HISTORY.index("@frappe.whitelist()")]
	for excluded in ("move", "purchasereturn", "processing", "demand", "salesreturn"):
		assert f'"{excluded}"' not in constants
	for included in ("supply", "enter", "loss"):
		assert f'"{included}"' in constants
