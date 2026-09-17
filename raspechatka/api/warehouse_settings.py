"""Administrative warehouse policy used by stock-norm calculations."""

import frappe
from frappe import _
from frappe.utils import cint

from raspechatka.access import get_scope
from raspechatka.access_contract import access_contract


def _ensure_network_scope():
	if not get_scope().get("global"):
		frappe.throw(_("Настройки склада доступны только администратору сети."), frappe.PermissionError)


def _policy_dict(doc):
	return {
		"analysis_days": cint(doc.analysis_days or 180),
		"minimum_days": cint(doc.minimum_days or 30),
		"target_days": cint(doc.target_days or 90),
	}


@frappe.whitelist()
@access_contract(area="page.warehouse.settings", action="read", scope="network")
def get_warehouse_policy():
	_ensure_network_scope()
	return _policy_dict(frappe.get_single("Warehouse Policy"))


@frappe.whitelist(methods=["POST"])
@access_contract(area="page.warehouse.settings", action="admin", scope="network")
def save_warehouse_policy(analysis_days, minimum_days, target_days):
	_ensure_network_scope()
	doc = frappe.get_single("Warehouse Policy")
	doc.analysis_days = cint(analysis_days)
	doc.minimum_days = cint(minimum_days)
	doc.target_days = cint(target_days)
	doc.save(ignore_permissions=True)
	return _policy_dict(doc)
