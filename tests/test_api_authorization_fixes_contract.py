import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "raspechatka/api"


def test_external_api_requires_page_access_codes_only():
	legacy = []
	pattern = re.compile(r'require_(?:any_)?access\(\s*"(?!page\.)')
	for path in API.rglob("*.py"):
		for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
			if pattern.search(line):
				legacy.append(f"{path.relative_to(ROOT)}:{line_number}")
	assert legacy == []
	assert 'require_access("page.references.users", "admin")' in (API / "users.py").read_text()


def test_permission_levels_keep_none_view_edit_admin_order():
	access = (ROOT / "raspechatka/access.py").read_text(encoding="utf-8")
	assert 'LEVELS = {"None": 0, "View": 1, "Edit": 2, "Admin": 3}' in access
	assert 'ACTION_LEVEL = {"read": 1, "create": 2, "write": 2, "delete": 3, "admin": 3}' in access


def test_finance_update_checks_persisted_document_before_payload_scope():
	source = (API / "finance.py").read_text(encoding="utf-8")
	section = source[source.index("def save_payment") : source.index("def get_cash_expense")]
	load = section.index('frappe.get_doc("Finance Transaction", data["name"])')
	old_entity = section.index("_ensure_entity(doc.business_entity)")
	payload_entity = section.index('_ensure_entity(data.get("business_entity"))')
	apply_payload = section.index("for fieldname in allowed")
	assert load < old_entity < payload_entity < apply_payload
	assert "_validate_payment_scope_links(doc)" in section
	for function_name, next_function in (
		("save_plan_item", "delete_plan_item"),
		("save_budget", "get_settlements"),
		("save_classification_rule", "archive_classification_rule"),
	):
		section = source[source.index(f"def {function_name}") : source.index(f"def {next_function}")]
		assert section.index("frappe.get_doc") < section.index("_ensure_entity(doc.business_entity)")


def test_supplier_payment_link_checks_transaction_scope_and_order_relation():
	source = (API / "supplier_settlements.py").read_text(encoding="utf-8")
	section = source[source.index("def link_payment") : source.index("def unlink_payment")]
	assert section.index("payment = _get_payment(payment_name)") < section.index("Supplier Payment Allocation")
	assert "payment.business_entity != order.business_entity" in section
	assert "payment.supplier != order.supplier" in section


def test_finance_supplier_options_and_cash_expense_are_scope_checked():
	source = (API / "finance.py").read_text(encoding="utf-8")
	assert '"suppliers": _get_allowed_suppliers()' in source
	assert 'row.scope == "Network"' in source
	assert 'row.business_entity in entities' in source
	cash = source[source.index("def create_cash_expense") : source.index("def record_cash_collection")]
	assert cash.index("_ensure_supplier(supplier, entity)") < cash.index('"doctype": "Cash Movement"')
	assert 'frappe.db.get_value("Business Entity", entity, "active")' in source
	assert '"Business Point", point, ["business_entity", "active"]' in source


def test_client_options_dashboard_marketing_and_members_do_not_leak_scope():
	source = (API / "clients.py").read_text(encoding="utf-8")
	assert 'point_filters["name"] = ["in", scope.get("points") or ["__none__"]]' in source
	assert 'client_filters["name"] = ["in", visible]' in source
	assert 'filters["name"] = ["in", visible]' in source
	assert source.count("_require_network_scope()") >= 6
	assert '_require_point_visible(data.get("business_point"))' in source


def test_pos_receipt_search_uses_authenticated_connection_point_only():
	source = (API / "receipt_search.py").read_text(encoding="utf-8")
	section = source[source.index("def search_receipts") :]
	assert "connection = base_pos._authenticate(device_id, token)" in section
	assert "point = connection.business_point" in section
	assert '["Sales Receipt", "business_point", "=", point]' in section
	signature = section[: section.index("):")]
	assert "business_point" not in signature


def test_inventory_mentions_every_whitelisted_endpoint():
	inventory = (ROOT / "docs/api-authorization-inventory.md").read_text(encoding="utf-8")
	missing_modules = []
	for path in ROOT.joinpath("raspechatka").rglob("*.py"):
		text = path.read_text(encoding="utf-8")
		if "frappe.whitelist" not in text:
			continue
		module = ".".join(path.relative_to(ROOT / "raspechatka").with_suffix("").parts)
		if module.split(".")[-1] not in inventory:
			missing_modules.append(module)
	assert missing_modules == []

