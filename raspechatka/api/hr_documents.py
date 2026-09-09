import html
import json
import re
from datetime import date
from pathlib import Path

import frappe
from frappe import _
from frappe.utils import cint, flt, formatdate, getdate, now_datetime
from frappe.utils.file_manager import save_file
from frappe.utils.pdf import get_pdf

from raspechatka.access import get_scope, require_access
from raspechatka.dadata import find_bank
from raspechatka.requisites import digits, is_valid_bank_account, is_valid_bic, is_valid_inn, is_valid_snils


VARIABLES = [
	{"key": "FIO_FULL", "label": "ФИО полностью"},
	{"key": "FIO_SHORT", "label": "Фамилия и инициалы"},
	{"key": "BIRTH_DATE", "label": "Дата рождения"},
	{"key": "CONTRACT_DATE", "label": "Дата приёма"},
	{"key": "CONTRACT_YEAR", "label": "Год приёма"},
	{"key": "REG_ADDRESS", "label": "Адрес регистрации"},
	{"key": "PHONE", "label": "Телефон"},
	{"key": "PASSPORT_SERIES", "label": "Серия паспорта"},
	{"key": "PASSPORT_NUMBER", "label": "Номер паспорта"},
	{"key": "PASSPORT_ISSUE_DATE", "label": "Дата выдачи паспорта"},
	{"key": "PASSPORT_ISSUED_BY", "label": "Кем выдан паспорт"},
	{"key": "PASSPORT_DEPARTMENT_CODE", "label": "Код подразделения"},
	{"key": "CITIZEN_WORD", "label": "Гражданин / гражданка"},
	{"key": "WORKER_NAMED", "label": "Именуемый / именуемая"},
	{"key": "EMPLOYER_NAME", "label": "Работодатель"},
	{"key": "EMPLOYER_INN", "label": "ИНН работодателя"},
	{"key": "EMPLOYER_OGRNIP", "label": "ОГРНИП работодателя"},
	{"key": "EMPLOYER_ADDRESS", "label": "Адрес работодателя"},
	{"key": "EMPLOYER_SHORT", "label": "Краткая подпись работодателя"},
	{"key": "EMPLOYER_PHONE", "label": "Телефон работодателя"},
	{"key": "POSITION", "label": "Должность"},
	{"key": "WORKPLACE_NAME", "label": "Точка продаж"},
	{"key": "WORKPLACE_CITY", "label": "Город работы"},
	{"key": "WORKPLACE_ADDRESS", "label": "Адрес места работы"},
	{"key": "PAY_CONDITIONS", "label": "Условия оплаты труда"},
	{"key": "ANNUAL_LEAVE_DAYS", "label": "Дней ежегодного отпуска"},
	{"key": "FIRST_HALF_PAY_DAY", "label": "День выплаты аванса"},
	{"key": "SECOND_HALF_PAY_DAY", "label": "День окончательной выплаты"},
]
ALLOWED_VARIABLES = {row["key"] for row in VARIABLES}
MARKER_RE = re.compile(r"{{\s*([A-Z0-9_]+)\s*}}")
UNSAFE_HTML_RE = re.compile(r"<\s*(script|iframe|object|embed|link|meta)\b|\bon\w+\s*=", re.IGNORECASE)
DEFAULT_TEMPLATES_FILE = Path(__file__).resolve().parents[1] / "hr_default_templates.json"


def _require_network_admin():
	require_access("team.hr", "write")
	if not get_scope()["global"]:
		frappe.throw(_("Шаблоны кадровых документов изменяет только администратор сети"), frappe.PermissionError)


def _assert_employee_access(employee):
	scope = get_scope()
	if scope["global"]:
		return
	allowed_entities = scope.get("business_entities") or [scope.get("business_entity")]
	if employee.business_entity not in allowed_entities:
		frappe.throw(_("Сотрудник недоступен"), frappe.PermissionError)


def _short_name(employee):
	parts = [employee.last_name, employee.first_name, employee.middle_name]
	initials = "".join(f"{part[0].upper()}." for part in parts[1:] if part)
	return f"{parts[0]} {initials}".strip()


def _date(value):
	return formatdate(value, "dd.MM.yyyy") if value else ""


def _person_short(last_name, first_name, middle_name=None):
	initials = "".join(f"{part[0].upper()}." for part in (first_name, middle_name) if part)
	return f"{last_name or ''} {initials}".strip()


def _password(doc, fieldname):
	try:
		return doc.get_password(fieldname, raise_exception=False) or ""
	except Exception:
		return ""


def _employee_variables(employee):
	entity = frappe.get_doc("Business Entity", employee.business_entity)
	position = frappe.db.get_value("Position", employee.position, "position_name") or employee.position or ""
	assignment = next((row for row in employee.assigned_points if cint(row.is_default)), None)
	assignment = assignment or (employee.assigned_points[0] if employee.assigned_points else None)
	point = frappe.get_doc("Business Point", assignment.business_point) if assignment else None
	components = frappe.get_all(
		"Payroll Accrual Type",
		filters={
			"active": 1,
			"business_point": point.name if point else "__none__",
			"position": employee.position,
		},
		fields=["component_name", "calculation_basis", "default_rate", "default_percent", "payment_method"],
		order_by="component_name asc",
		limit_page_length=100,
	)
	policy_name = frappe.db.get_value("Payroll Policy", {"business_point": point.name, "active": 1}, "name") if point else None
	policy = frappe.get_doc("Payroll Policy", policy_name) if policy_name else frappe._dict(annual_leave_days=28, first_half_pay_day=20, second_half_pay_day=5)
	conditions = []
	for row in components:
		if row.calculation_basis == "Hours":
			value = f"{flt(row.default_rate):g} руб. за час"
		elif row.calculation_basis == "Personal Sales":
			value = f"{flt(row.default_percent):g}% от личной выручки"
		elif row.calculation_basis == "Fixed Amount":
			value = f"{flt(row.default_rate):g} руб."
		else:
			value = "по результатам расчётного периода"
		conditions.append(f"{row.component_name}: {value}")
	female = employee.gender == "Женский"
	contract_date = employee.hire_date
	return {
		"FIO_FULL": employee.employee_name or "",
		"FIO_SHORT": _short_name(employee),
		"BIRTH_DATE": _date(employee.birth_date),
		"CONTRACT_DATE": _date(contract_date),
		"CONTRACT_YEAR": str(getdate(contract_date).year) if contract_date else "",
		"REG_ADDRESS": employee.registration_address or "",
		"PHONE": employee.phone or "",
		"PASSPORT_SERIES": _password(employee, "passport_series"),
		"PASSPORT_NUMBER": _password(employee, "passport_number"),
		"PASSPORT_ISSUE_DATE": _date(employee.passport_issue_date),
		"PASSPORT_ISSUED_BY": employee.passport_issued_by or "",
		"PASSPORT_DEPARTMENT_CODE": employee.passport_department_code or "",
		"CITIZEN_WORD": "гражданка" if female else "гражданин",
		"WORKER_NAMED": "именуемая" if female else "именуемый",
		"EMPLOYER_NAME": entity.full_name or entity.short_name or "",
		"EMPLOYER_INN": entity.inn or "",
		"EMPLOYER_OGRNIP": entity.ogrnip or "",
		"EMPLOYER_ADDRESS": entity.registration_address or "",
		"EMPLOYER_SHORT": _person_short(entity.last_name, entity.first_name, entity.middle_name),
		"EMPLOYER_PHONE": entity.phone or "",
		"POSITION": position,
		"WORKPLACE_NAME": point.point_name if point else "",
		"WORKPLACE_CITY": point.city if point else "",
		"WORKPLACE_ADDRESS": point.address if point else "",
		"PAY_CONDITIONS": "; ".join(conditions),
		"ANNUAL_LEAVE_DAYS": f"{flt(policy.annual_leave_days):g}",
		"FIRST_HALF_PAY_DAY": str(cint(policy.first_half_pay_day)),
		"SECOND_HALF_PAY_DAY": str(cint(policy.second_half_pay_day)),
	}


@frappe.whitelist()
def get_hr_template_settings():
	require_access("team.hr", "read")
	return {
		"variables": VARIABLES,
		"templates": frappe.get_all(
			"HR Document Template",
			fields=["name", "template_name", "document_type", "version", "active", "template_html", "notes", "modified"],
			order_by="document_type asc, modified desc",
			limit_page_length=100,
		),
		"can_edit": bool(get_scope()["global"]),
	}


@frappe.whitelist(methods=["POST"])
def save_hr_template(data):
	_require_network_admin()
	data = frappe.parse_json(data)
	template_html = data.get("template_html") or ""
	if UNSAFE_HTML_RE.search(template_html):
		frappe.throw(_("Шаблон содержит небезопасный HTML-код"))
	markers = set(MARKER_RE.findall(template_html))
	unknown = sorted(markers - ALLOWED_VARIABLES)
	if unknown:
		frappe.throw(_("Неизвестные переменные: {0}").format(", ".join(unknown)))
	name = data.get("name")
	previous = frappe.get_doc("HR Document Template", name) if name else None
	new_version = bool(previous and previous.template_html != data.get("template_html"))
	if new_version:
		previous.active = 0
		previous.save(ignore_permissions=True)
		doc = frappe.new_doc("HR Document Template")
		doc.version = cint(previous.version) + 1
	else:
		doc = previous or frappe.new_doc("HR Document Template")
		doc.version = cint(doc.version) or 1
	for fieldname in ("template_name", "document_type", "active", "template_html", "notes"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save(ignore_permissions=True)
	if cint(doc.active):
		for other in frappe.get_all(
			"HR Document Template",
			filters={"document_type": doc.document_type, "active": 1, "name": ["!=", doc.name]},
			pluck="name",
		):
			frappe.db.set_value("HR Document Template", other, "active", 0, update_modified=False)
	return {"name": doc.name, "version": doc.version}


@frappe.whitelist(methods=["POST"])
def create_default_hr_templates():
	_require_network_admin()
	with DEFAULT_TEMPLATES_FILE.open(encoding="utf-8") as source:
		defaults = json.load(source)
	created = 0
	for template in defaults:
		if frappe.db.exists("HR Document Template", {"document_type": template["document_type"], "active": 1}):
			continue
		frappe.get_doc({
			"doctype": "HR Document Template",
			"template_name": template["template_name"],
			"document_type": template["document_type"],
			"version": 1,
			"active": 1,
			"template_html": template["template_html"],
			"notes": f"Перенесено из актуального Google Docs: {template['source_google_doc_id']}",
		}).insert(ignore_permissions=True)
		created += 1
	return {"created": created}

@frappe.whitelist()
def lookup_employee_bank(bic):
	require_access("team.employees", "read")
	bic = digits(bic)
	if not is_valid_bic(bic):
		frappe.throw(_("БИК должен содержать 9 цифр"))
	suggestion = find_bank(bic)
	data = suggestion.get("data") or {}
	name = data.get("name") or {}
	return {
		"salary_bic": data.get("bic") or bic,
		"salary_bank_name": name.get("payment") or name.get("short") or name.get("full") or suggestion.get("value") or "",
		"salary_correspondent_account": data.get("correspondent_account") or "",
	}


@frappe.whitelist(methods=["POST"])
def validate_employee_requisites(data):
	require_access("team.employees", "write")
	data = frappe.parse_json(data)
	errors = []
	if data.get("inn") and not is_valid_inn(data.get("inn")):
		errors.append(_("Некорректный ИНН"))
	if data.get("snils") and not is_valid_snils(data.get("snils")):
		errors.append(_("Некорректный СНИЛС"))
	if data.get("salary_bic") and not is_valid_bic(data.get("salary_bic")):
		errors.append(_("Некорректный БИК"))
	if data.get("salary_account") and not is_valid_bank_account(data.get("salary_account"), data.get("salary_bic")):
		errors.append(_("Некорректный счёт получателя"))
	if data.get("salary_correspondent_account") and not is_valid_bank_account(
		data.get("salary_correspondent_account"), data.get("salary_bic"), correspondent=True
	):
		errors.append(_("Некорректный корреспондентский счёт"))
	return {"valid": not errors, "errors": errors}


@frappe.whitelist(methods=["POST"])
def generate_employment_documents(employee, force=0):
	require_access("team.hr", "write")
	doc = frappe.get_doc("Employee", employee)
	_assert_employee_access(doc)
	variables = _employee_variables(doc)
	templates = frappe.get_all(
		"HR Document Template",
		filters={"active": 1},
		fields=["name", "template_name", "document_type", "version", "template_html"],
		order_by="document_type asc",
		limit_page_length=100,
	)
	if not templates:
		frappe.throw(_("Сначала настройте шаблоны кадровых документов"))
	created = []
	for template in templates:
		version_note = f"Шаблон {template.name}, версия {template.version}"
		if not cint(force) and any(row.document_type == template.document_type and row.notes == version_note for row in doc.documents):
			continue
		markers = set(MARKER_RE.findall(template.template_html or ""))
		missing = sorted(key for key in markers if not str(variables.get(key) or "").strip())
		if missing:
			labels = {row["key"]: row["label"] for row in VARIABLES}
			frappe.throw(_("Для формирования «{0}» заполните: {1}").format(
				template.template_name, ", ".join(labels.get(key, key) for key in missing)
			))
		rendered = template.template_html or ""
		for key in markers:
			rendered = re.sub(r"{{\s*" + re.escape(key) + r"\s*}}", html.escape(str(variables[key])), rendered)
		page = f"""<!doctype html><html><head><meta charset="utf-8"><style>
			body {{ font-family: DejaVu Sans, sans-serif; font-size: 12pt; line-height: 1.45; }}
			h1 {{ text-align: center; font-size: 16pt; }} p {{ text-align: justify; }}
		</style></head><body>{rendered}</body></html>"""
		pdf = get_pdf(page)
		file_date = _date(doc.hire_date) or date.today().strftime("%d.%m.%Y")
		filename = f"{template.template_name} — {doc.employee_name} — {file_date}.pdf"
		file_doc = save_file(filename, pdf, "Employee", doc.name, is_private=1)
		doc.append("documents", {
			"document_type": template.document_type,
			"status": "Черновик",
			"file": file_doc.file_url,
			"issue_date": doc.hire_date or date.today(),
			"notes": version_note,
		})
		created.append({"type": template.document_type, "file": file_doc.file_url, "version": template.version})
	doc.save(ignore_permissions=True)
	return {"created": created, "count": len(created), "generated_at": now_datetime()}
