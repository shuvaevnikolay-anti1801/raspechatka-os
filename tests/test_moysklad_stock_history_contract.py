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
BATCH = json.loads(
	(
		ROOT
		/ "raspechatka/raspechatka_os/doctype/moysklad_stock_import_batch/moysklad_stock_import_batch.json"
	).read_text(encoding="utf-8")
)
RECONCILIATION = (ROOT / "raspechatka/stock_reconciliation.py").read_text(encoding="utf-8")
SETTINGS = json.loads(
	(ROOT / "raspechatka/raspechatka_os/doctype/moysklad_settings/moysklad_settings.json").read_text(
		encoding="utf-8"
	)
)
HOOKS = (ROOT / "raspechatka/hooks.py").read_text(encoding="utf-8")
INTEGRATION_PAGE = (ROOT / "frontend/src/pages/MoySkladIntegrationPage.vue").read_text(encoding="utf-8")


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
	assert 'frappe.db.get_value(doctype, {"external_id": external_id}, "name")' in stock_doc
	assert '"import_batch": import_batch' in backfill
	assert 'stats["sales_stock_duplicates"]' in backfill


def test_stock_movements_are_never_deleted_by_history_import():
	assert 'frappe.delete_doc("Stock Ledger Entry"' not in HISTORY
	assert 'frappe.db.delete("Stock Ledger Entry"' not in HISTORY


def test_rebuild_creates_version_without_destructive_reset():
	assert "start_stock_history_rebuild" in HISTORY
	assert "_reset_initial_history" not in HISTORY
	assert 'batch.status = "Running"' in HISTORY


def test_old_batch_remains_auditable_as_superseded():
	statuses = next(field for field in BATCH["fields"] if field["fieldname"] == "status")["options"]
	assert "Active" in statuses
	assert "Superseded" in statuses
	assert '"Superseded"' in _section(HISTORY, "def _activate_import_batch", "def _fail_import_batch")


def test_only_active_batch_affects_working_balance():
	assert "batch.status = 'Active'" in STOCK
	assert 'effective_ledger_condition(alias="")' in RECONCILIATION


def test_rebuild_movement_identity_includes_batch():
	movement_key = _section(STOCK, "def _movement_key", "def _default_valuation_source")
	assert "import_batch=None" in movement_key
	assert 'str(import_batch or "")' in movement_key


def test_automatic_stock_sync_is_installed_but_disabled_by_default():
	field = next(field for field in SETTINGS["fields"] if field["fieldname"] == "stock_sync_enabled")
	assert field["default"] == "0"
	assert "sync_enabled_stock_documents" in HOOKS
	assert 'v-model="stockHistory.auto_sync.enabled"' in INTEGRATION_PAGE
	assert "save_stock_sync_settings" in INTEGRATION_PAGE


def test_automatic_stock_sync_imports_only_stock_documents():
	section = _section(HISTORY, "def run_stock_document_sync", "def _stock_sync_is_stale")
	assert "for source_kind, endpoint, target in IMPORT_DOCUMENTS" in section
	assert "_sales_receipt_events" not in section
	assert "_rebuild_operational_balances" in section
	assert 'frappe.db.exists(doctype, {"external_id": external_id})' in section


def test_excluded_source_document_types_are_not_imported_or_audited():
	constants = HISTORY[: HISTORY.index("@frappe.whitelist()")]
	for excluded in ("move", "purchasereturn", "processing", "demand", "salesreturn"):
		assert f'"{excluded}"' not in constants
	for included in ("supply", "enter", "loss"):
		assert f'"{included}"' in constants
