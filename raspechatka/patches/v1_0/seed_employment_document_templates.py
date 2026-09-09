import json
from pathlib import Path

import frappe
from frappe.utils import cint


TEMPLATES_FILE = Path(__file__).resolve().parents[2] / "hr_default_templates.json"


def execute():
	with TEMPLATES_FILE.open(encoding="utf-8") as source:
		templates = json.load(source)
	for template in templates:
		note = f"Перенесено из актуального Google Docs: {template['source_google_doc_id']}"
		if frappe.db.exists("HR Document Template", {"notes": note}):
			continue
		existing = frappe.get_all(
			"HR Document Template",
			filters={"document_type": template["document_type"]},
			fields=["name", "version"],
			order_by="version desc",
			limit_page_length=1,
		)
		for name in frappe.get_all(
			"HR Document Template",
			filters={"document_type": template["document_type"], "active": 1},
			pluck="name",
		):
			frappe.db.set_value("HR Document Template", name, "active", 0, update_modified=False)
		version = cint(existing[0].version) + 1 if existing else 1
		frappe.get_doc({
			"doctype": "HR Document Template",
			"template_name": template["template_name"],
			"document_type": template["document_type"],
			"version": version,
			"active": 1,
			"template_html": template["template_html"],
			"notes": note,
		}).insert(ignore_permissions=True)
