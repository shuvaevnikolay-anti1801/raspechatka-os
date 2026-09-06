import frappe
from frappe import _

from raspechatka.access import get_scope, require_access


DOCUMENT_AREAS = {
	"Organization": "references.network",
	"Business Entity": "references.network",
	"Business Point": "references.network",
	"Catalog Warehouse": "references.storage",
	"Catalog Item": "references.catalog",
	"Catalog Group": "references.catalog",
	"Catalog Unit": "references.catalog",
	"Catalog Price Type": "references.catalog",
	"Catalog Supplier": "references.suppliers",
	"Client": "clients.base",
	"Client Segment": "clients.marketing",
	"Promo Campaign": "clients.marketing",
	"Promo Code": "clients.loyalty",
	"Promo Occasion": "clients.marketing",
	"Employee": "team.employees",
	"Position": "references.employees",
	"Payment Method": "references.finance",
	"POS Workplace": "references.finance",
	"Cash Register": "references.finance",
	"Financial Article": "references.finance",
	"Stock Receipt": "warehouse.operations",
	"Stock Write Off": "warehouse.operations",
	"Stock Inventory": "warehouse.operations",
	"Purchase Order": "warehouse.operations",
	"Finance Transaction": "finance.operations",
	"Finance Plan Item": "finance.planning",
	"Bank Operation": "finance.bank",
	"Sales Shift": "sales.shifts",
	"Sales Receipt": "sales.receipts",
	"Cash Movement": "sales.cash",
	"Cashier Action": "sales.audit",
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

STANDARD_FIELDS = {
	"name": {"label": _("Номер / ID"), "fieldtype": "Data", "type": "text", "options": []},
	"owner": {"label": _("Создал"), "fieldtype": "Link", "type": "text", "options": []},
	"creation": {"label": _("Дата создания"), "fieldtype": "Datetime", "type": "datetime-local", "options": []},
	"modified": {"label": _("Дата изменения"), "fieldtype": "Datetime", "type": "datetime-local", "options": []},
	"modified_by": {"label": _("Изменил"), "fieldtype": "Link", "type": "text", "options": []},
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
	fields = [{"key": key, **definition} for key, definition in STANDARD_FIELDS.items()]
	if meta.is_submittable:
		fields.append({
			"key": "docstatus",
			"label": _("Статус документа"),
			"fieldtype": "Int",
			"type": "select",
			"options": [
				{"value": "0", "label": _("Черновик")},
				{"value": "1", "label": _("Проведён")},
				{"value": "2", "label": _("Отменён")},
			],
		})
	fields.extend(_field_definition(field) for field in meta.fields if field.fieldtype in SCALAR_TYPES and not field.hidden)
	for table_field in (field for field in meta.fields if field.fieldtype in {"Table", "Table MultiSelect"} and field.options):
		child_meta = frappe.get_meta(table_field.options)
		for child_field in child_meta.fields:
			if child_field.fieldtype not in SCALAR_TYPES or child_field.hidden:
				continue
			definition = _field_definition(child_field)
			definition["key"] = f"{table_field.fieldname}.{child_field.fieldname}"
			definition["label"] = f"{table_field.label or table_field.fieldname} → {child_field.label or child_field.fieldname}"
			definition["child_table"] = table_field.fieldname
			fields.append(definition)
	return fields


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
		if field_key in STANDARD_FIELDS:
			fieldtype = STANDARD_FIELDS[field_key]["fieldtype"]
		elif field_key == "docstatus" and meta.is_submittable:
			fieldtype = "Int"
		elif field and field.fieldtype in SCALAR_TYPES:
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
	entity = scope["business_entity"] or "__none__"
	if doctype == "Business Entity":
		return {"name": entity}
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
		return {"business_entity": entity}
	if meta.has_field("warehouse"):
		warehouses = frappe.get_all("Catalog Warehouse", filters={"business_point": ["in", points]}, pluck="name", limit_page_length=1000)
		return {"warehouse": ["in", warehouses or ["__none__"]]}
	return {}
