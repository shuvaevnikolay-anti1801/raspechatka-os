from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative):
	return (ROOT / relative).read_text()


def test_doctype_metadata_does_not_publish_technical_ui_fields():
	source = read("raspechatka/api/list_filters.py")
	function = source[source.index("def get_doctype_filter_fields"):source.index("def filter_document_names")]
	assert "STANDARD_FIELDS.items()" not in function
	assert "FILTER_FIELD_ALLOWLIST" in function


def test_dynamic_filter_execution_rejects_fields_outside_allowlist():
	source = read("raspechatka/api/list_filters.py")
	function = source[source.index("def filter_document_names"):source.index("def _field_definition")]
	assert "field_key not in FILTER_FIELD_ALLOWLIST" in function
	assert "frappe.PermissionError" in function
	assert "_scope_filters(doctype, meta)" in function


def test_partner_control_page_uses_one_descriptor_for_form_filter_and_table():
	source = read("frontend/src/pages/MasterDataPage.vue")
	organization = source[source.index("organizations:"):source.index("clients:")]
	assert "entityFields: defineEntityFields" in organization
	assert "columns:" not in organization
	assert "fields:" not in organization
	assert ':entity-fields="entityFields"' in source
	assert "deriveFormFields(entityFields.value)" in source


def test_filter_never_appends_undeclared_doctype_fields():
	source = read("frontend/src/components/SmartFilterBar.vue")
	assert "configuredFields" in source
	assert "...schemaFields.value.filter" not in source
	assert 'class="smart-filter-search"' in source


def test_table_preference_contains_order_and_reconciliation():
	source = read("frontend/src/components/SmartDataTable.vue")
	assert "columnOrder" in source
	assert "reconcileColumnOrder" in source
	assert "dropColumn" in source
	assert "widths" in source
	assert "pageSize" in source


def test_all_standard_list_pages_pass_entity_descriptor_to_shared_widgets():
	for page in (ROOT / "frontend/src/pages").glob("*Page.vue"):
		source = page.read_text()
		if not any(tag in source for tag in ("<SmartFilterBar", "<SmartDataTable", "<ReferenceTable")):
			continue
		assert ":entity-fields=" in source, page.name
		assert ':fields="filterFields"' not in source, page.name
		assert ':columns="columns"' not in source, page.name
