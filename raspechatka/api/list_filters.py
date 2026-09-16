import frappe
from frappe import _

from raspechatka.access import get_allowed_entities, get_scope, require_access

DOCUMENT_AREAS = {
	"Organization": "page.references.organizations",
	"Business Entity": "page.references.entities",
	"Business Point": "page.references.points",
	"Catalog Warehouse": "page.references.warehouses",
	"Catalog Item": "page.catalog",
	"Catalog Group": "page.catalog",
	"Catalog Unit": "page.catalog",
	"Catalog Price Type": "page.catalog",
	"Catalog Supplier": "page.references.suppliers",
	"Client": "page.clients.list",
	"Client Segment": "page.clients.segments",
	"Promo Campaign": "page.clients.campaigns",
	"Promo Code": "page.clients.promo_codes",
	"Promo Occasion": "page.clients.calendar",
	"Employee": "page.team.employees",
	"Position": "page.team.positions",
	"Payment Method": "page.finance.settings",
	"POS Workplace": "page.sales.integration",
	"Cash Register": "page.sales.integration",
	"Financial Article": "page.finance.settings",
	"Stock Receipt": "page.warehouse.receipts",
	"Stock Write Off": "page.warehouse.write_offs",
	"Stock Inventory": "page.warehouse.inventories",
	"Purchase Order": "page.warehouse.purchase_orders",
	"Finance Transaction": "page.finance.payments",
	"Finance Plan Item": "page.finance.calendar",
	"Bank Operation": "page.finance.bank",
	"Sales Shift": "page.sales.shifts",
	"Sales Receipt": "page.sales.receipts",
	"Cash Movement": "page.sales.cash",
	"Cashier Action": "page.sales.audit",
}

SCALAR_TYPES = {
	"Attach", "Attach Image", "Barcode", "Check", "Code", "Color", "Currency", "Data",
	"Date", "Datetime", "Duration", "Dynamic Link", "Float", "Geolocation", "HTML Editor",
	"Int", "JSON", "Link", "Long Text", "Markdown Editor", "Percent", "Phone",
	"Rating", "Read Only", "Select", "Small Text", "Text", "Text Editor", "Time",
}
NUMBER_TYPES = {"Currency", "Float", "Int", "Percent", "Rating", "Duration"}
TEXT_TYPES = {
	"Attach", "Attach Image", "Barcode", "Code", "Color", "Data", "Dynamic Link", "Geolocation",
	"HTML Editor", "JSON", "Link", "Long Text", "Markdown Editor", "Phone",
	"Read Only", "Small Text", "Text", "Text Editor",
}

FILTER_FIELD_ALLOWLIST = {
	"Organization": {"organization_name", "phone", "email", "address", "active"},
	"Business Entity": {"short_name", "full_name", "organization", "inn", "tax_system", "phone", "email", "active"},
	"Business Point": {"point_name", "business_entity", "city", "address", "phone", "email", "timezone", "active"},
	"Catalog Warehouse": {"warehouse_name", "business_point", "active"},
	"Catalog Item": {"item_name", "sku", "barcode", "catalog_group", "unit", "item_type", "active"},
	"Catalog Group": {"group_name", "parent_catalog_group", "is_group", "active"},
	"Catalog Unit": {"unit_name", "symbol", "allow_fraction", "active"},
	"Catalog Price Type": {"price_type_name", "purpose", "currency", "active"},
	"Catalog Supplier": {"supplier_name", "supplier_type", "scope", "business_entity", "inn", "phone", "email", "active"},
	"Client": {"client_name", "last_name", "first_name", "middle_name", "phone", "email", "registration_point", "personal_data_consent", "marketing_consent", "active"},
	"Client Segment": {"segment_name", "description", "active"},
	"Promo Campaign": {"campaign_name", "status", "starts_on", "ends_on", "active"},
	"Promo Code": {"promo_code", "campaign", "status", "active"},
	"Promo Occasion": {"occasion_name", "occasion_date", "active"},
	"Employee": {"employee_name", "business_entity", "position", "employment_type", "phone", "email", "hire_date", "dismissal_date", "active"},
	"Position": {"position_name", "description", "active"},
	"Payment Method": {"method_name", "method_type", "active"},
	"POS Workplace": {"workplace_name", "business_point", "active"},
	"Cash Register": {"register_name", "business_point", "currency", "active"},
	"Financial Article": {"article_name", "article_type", "parent_financial_article", "is_group", "active"},
	"Stock Receipt": {"posting_date", "business_point", "warehouse", "supplier", "status", "total_amount"},
	"Stock Write Off": {"posting_date", "business_point", "warehouse", "status", "total_amount"},
	"Stock Inventory": {"posting_date", "business_point", "warehouse", "status"},
	"Purchase Order": {"posting_date", "business_point", "warehouse", "supplier", "status", "total_amount"},
	"Finance Transaction": {"posting_date", "business_entity", "business_point", "transaction_type", "article", "status", "amount", "description"},
	"Finance Plan Item": {"plan_date", "business_entity", "business_point", "article", "status", "amount", "description"},
	"Bank Operation": {"posting_date", "business_entity", "bank_account", "operation_type", "processing_status", "amount", "description"},
	"Sales Shift": {"shift_type", "opened_at", "closed_at", "business_point", "cashier", "status"},
	"Sales Receipt": {"posting_datetime", "business_point", "cashier", "receipt_type", "payment_method", "status", "total"},
	"Cash Movement": {"posting_datetime", "movement_type", "business_point", "cashier", "amount", "reason"},
	"Cashier Action": {"action_datetime", "action_type", "business_point", "cashier", "shift", "details"},
}
OPERATORS = {
	"equals": "=", "not_equals": "!=", "contains": "like", "not_contains": "not like",
	"greater_than": ">", "greater_or_equal": ">=", "less_than": "<", "less_or_equal": "<=",
	"is_set": "is", "is_not_set": "is",
}


@frappe.whitelist()
def get_doctype_filter_fields(doctype):
	_require_doctype(doctype)
	meta = frappe.get_meta(doctype)
	allowed = FILTER_FIELD_ALLOWLIST.get(doctype, set())
	return [_field_definition(field) for field in meta.fields if field.fieldname in allowed and field.fieldtype in SCALAR_TYPES and not field.hidden]


@frappe.whitelist()
def filter_document_names(doctype, filters=None):
	_require_doctype(doctype)
	criteria = frappe.parse_json(filters) if isinstance(filters, str) else (filters or [])
	meta = frappe.get_meta(doctype)
	main_filters = _scope_filters(doctype, meta)
	matching_names = None

	for criterion in criteria:
		field_key = criterion.get("fieldname")
		operator_key = criterion.get("operator") or "equals"
		value = criterion.get("value")
		if not field_key or operator_key not in OPERATORS:
			continue
		if field_key not in FILTER_FIELD_ALLOWLIST.get(doctype, set()):
			frappe.throw(_("Поле недоступно для фильтрации в этом списке"), frappe.PermissionError)
		if "." in field_key:
			table_fieldname, child_fieldname = field_key.split(".", 1)
			table_field = meta.get_field(table_fieldname)
			if not table_field or table_field.fieldtype not in {"Table", "Table MultiSelect"} or not table_field.options:
				frappe.throw(_("Недопустимое поле фильтра"), frappe.ValidationError)
			child_meta = frappe.get_meta(table_field.options)
			child_field = child_meta.get_field(child_fieldname)
			if not child_field or child_field.fieldtype not in SCALAR_TYPES:
				frappe.throw(_("Недопустимое поле фильтра"), frappe.ValidationError)
			condition = _condition(child_fieldname, child_field.fieldtype, operator_key, value)
			child_names = set(frappe.get_all(
				table_field.options,
				filters={"parenttype": doctype, "parentfield": table_fieldname, child_fieldname: condition},
				pluck="parent",
				limit_page_length=10000,
			))
			matching_names = child_names if matching_names is None else matching_names & child_names
			continue
		field = meta.get_field(field_key)
		if field and field.fieldtype in SCALAR_TYPES:
			fieldtype = field.fieldtype
		else:
			frappe.throw(_("Недопустимое поле фильтра"), frappe.ValidationError)
		main_filters[field_key] = _condition(field_key, fieldtype, operator_key, value)

	if matching_names is not None:
		main_filters["name"] = ["in", list(matching_names) or ["__none__"]]
	return frappe.get_all(doctype, filters=main_filters, pluck="name", limit_page_length=10000)


def _field_definition(field):
	if field.fieldtype == "Select":
		input_type = "select"
		options = [{"value": value, "label": value} for value in (field.options or "").splitlines() if value and not value.startswith("eval:")]
	elif field.fieldtype == "Check":
		input_type = "select"
		options = [{"value": "1", "label": _("Да")}, {"value": "0", "label": _("Нет")}]
	elif field.fieldtype in NUMBER_TYPES:
		input_type, options = "number", []
	elif field.fieldtype == "Date":
		input_type, options = "date", []
	elif field.fieldtype == "Datetime":
		input_type, options = "datetime-local", []
	elif field.fieldtype == "Time":
		input_type, options = "time", []
	else:
		input_type, options = "text", []
	return {"key": field.fieldname, "label": field.label or field.fieldname, "type": input_type, "fieldtype": field.fieldtype, "options": options}


def _condition(fieldname, fieldtype, operator_key, value):
	operator = OPERATORS[operator_key]
	if operator_key in {"is_set", "is_not_set"}:
		return [operator, "set" if operator_key == "is_set" else "not set"]
	if value in (None, ""):
		frappe.throw(_("Укажите значение фильтра для поля {0}").format(fieldname), frappe.ValidationError)
	if operator_key in {"contains", "not_contains"}:
		value = f"%{value}%"
	if fieldtype == "Check":
		value = 1 if str(value) in {"1", "true", "True"} else 0
	return [operator, value]


def _require_doctype(doctype):
	area = DOCUMENT_AREAS.get(doctype)
	if not area:
		frappe.throw(_("Этот тип документа недоступен для динамической фильтрации"), frappe.PermissionError)
	require_access(area, "read")


def _scope_filters(doctype, meta):
	scope = get_scope()
	if scope["global"]:
		return {}
	points = scope["points"] or ["__none__"]
	entities = get_allowed_entities(scope) or ["__none__"]
	if doctype == "Business Entity":
		return {"name": ["in", entities]}
	if doctype == "Business Point":
		return {"name": ["in", points]}
	if doctype == "Client":
		return {"registration_point": ["in", points]}
	if doctype == "Catalog Item":
		items = frappe.get_all("Catalog Assortment", filters={"business_point": ["in", points], "enabled": 1}, pluck="item", limit_page_length=10000)
		return {"name": ["in", items or ["__none__"]]}
	if meta.has_field("business_point"):
		return {"business_point": ["in", points]}
	if meta.has_field("business_entity"):
		return {"business_entity": ["in", entities]}
	if meta.has_field("warehouse"):
		warehouses = frappe.get_all("Catalog Warehouse", filters={"business_point": ["in", points]}, pluck="name", limit_page_length=1000)
		return {"warehouse": ["in", warehouses or ["__none__"]]}
	return {}
