# ruff: noqa: RUF001
"""Admin deletion boundary. Domain strategies are registered explicitly in later DEV-181 parts."""

from dataclasses import dataclass
from functools import partial

import frappe
from frappe import _
from frappe.utils import now_datetime

from raspechatka.access import get_scope, require_access
from raspechatka.access_contract import access_contract
from raspechatka.scope import ensure_entity_allowed, ensure_point_allowed


@dataclass(frozen=True)
class DeletionRule:
	doctype: str
	area: str
	scope: str
	handler: object


def _blocked(doc, *, execute=False):
	return {
		"strategy": "blocked",
		"deleted": False,
		"can_delete": False,
		"message": _("Для этого типа сущности безопасное удаление ещё не реализовано"),
		"dependencies": {},
		"affected": [],
		"warnings": [],
	}


def _references(doctype, filters):
	return frappe.get_all(doctype, filters=filters, pluck="name", limit_page_length=100000)


def _dependency_probe(doc):
	"""Only explicit business dependencies are considered safe to inspect here."""
	dependencies = {}
	if doc.doctype == "Sales Receipt":
		if doc.receipt_type == "Sale":
			filters = {"original_receipt": doc.name, "receipt_type": "Return"}
			if doc.docstatus == 1:
				filters["docstatus"] = 1
			returns = _references("Sales Receipt", filters)
			if returns:
				dependencies["Sales Receipt Return"] = returns
	elif doc.doctype == "Purchase Order":
		for doctype in ("Stock Receipt", "Supplier Payment Allocation"):
			names = _references(doctype, {"purchase_order": doc.name})
			if names:
				dependencies[doctype] = names
	elif doc.doctype == "Cash Movement":
		transactions = _references("Finance Transaction", {"cash_movement": doc.name, "docstatus": 1})
		if transactions:
			allocations = _references(
				"Supplier Payment Allocation",
				{
					"finance_transaction": ["in", transactions],
				},
			)
			if allocations:
				dependencies["Supplier Payment Allocation"] = allocations
	if doc.docstatus == 0:
		# A draft must have no existing derived effects, including inconsistent
		# historical rows left by an interrupted or imported workflow.
		checks = (
			("Stock Ledger Entry", {"voucher_type": doc.doctype, "voucher_no": doc.name}),
			("Cashier Action", {"reference_doctype": doc.doctype, "reference_document": doc.name}),
		)
		if doc.doctype == "Sales Receipt":
			checks += (
				("Profitability Entry", {"source_doctype": doc.doctype, "source_document": doc.name}),
				("Client Purchase", {"source_document": doc.name}),
			)
		if doc.doctype == "Cash Movement":
			checks += (("Finance Transaction", {"cash_movement": doc.name}),)
		for doctype, filters in checks:
			names = _references(doctype, filters)
			if names:
				dependencies[doctype] = names
	return dependencies


def _affected_after_cancel(doc):
	affected = [{"doctype": doc.doctype, "name": doc.name, "docstatus": 2}]
	if doc.doctype in ("Sales Receipt", "Stock Receipt", "Stock Write Off", "Stock Inventory"):
		for name in _references(
			"Stock Ledger Entry",
			{
				"voucher_type": doc.doctype,
				"voucher_no": doc.name,
				"is_reversal": 1,
			},
		):
			affected.append({"doctype": "Stock Ledger Entry", "name": name})
	if doc.doctype == "Sales Receipt":
		for name in _references(
			"Profitability Entry",
			{
				"source_doctype": doc.doctype,
				"source_document": doc.name,
			},
		):
			affected.append({"doctype": "Profitability Entry", "name": name})
		for name in _references("Client Purchase", {"source_document": doc.name}):
			affected.append({"doctype": "Client Purchase", "name": name})
	if doc.doctype == "Cash Movement":
		for name in _references("Finance Transaction", {"cash_movement": doc.name}):
			affected.append({"doctype": "Finance Transaction", "name": name})
	if doc.doctype == "Stock Receipt" and doc.purchase_order:
		affected.append({"doctype": "Purchase Order", "name": doc.purchase_order})
	if doc.doctype in ("Sales Receipt", "Cash Movement"):
		affected.append({"doctype": "Sales Shift", "name": doc.shift})
	return affected


def _operational(doc, *, execute=False):
	if doc.docstatus not in (0, 1):
		return {
			"strategy": "blocked",
			"deleted": False,
			"can_delete": False,
			"message": _("Документ уже отменён или имеет неподдерживаемый статус"),
			"dependencies": {},
			"affected": [],
			"warnings": [],
		}
	dependencies = _dependency_probe(doc)
	if dependencies:
		return {
			"strategy": "blocked",
			"deleted": False,
			"can_delete": False,
			"message": _("Сначала отмените или удалите зависимые документы"),
			"dependencies": {
				doctype: {"count": len(names), "names": names} for doctype, names in dependencies.items()
			},
			"affected": [],
			"warnings": [],
		}
	strategy = "hard_delete" if doc.docstatus == 0 else "cancel"
	result = {
		"strategy": strategy,
		"deleted": bool(execute),
		"can_delete": True,
		"message": _("Черновик будет удалён")
		if strategy == "hard_delete"
		else _("Документ будет отменён; история сохранится"),
		"dependencies": {},
		"affected": [],
		"warnings": [],
	}
	if execute:
		if strategy == "hard_delete":
			frappe.delete_doc(doc.doctype, doc.name, ignore_permissions=True)
			result["affected"] = [{"doctype": doc.doctype, "name": doc.name, "deleted": True}]
		else:
			doc.flags.ignore_permissions = True
			doc.cancel()
			result["affected"] = _affected_after_cancel(doc)
	return result


def _sales_receipt(doc, *, execute=False):
	return _operational(doc, execute=execute)


def _cash_movement(doc, *, execute=False):
	return _operational(doc, execute=execute)


def _stock_receipt(doc, *, execute=False):
	return _operational(doc, execute=execute)


def _stock_write_off(doc, *, execute=False):
	return _operational(doc, execute=execute)


def _stock_inventory(doc, *, execute=False):
	return _operational(doc, execute=execute)


def _purchase_order(doc, *, execute=False):
	return _operational(doc, execute=execute)


SHIFT_TECHNICAL_ACTIONS = frozenset({"OPEN_SHIFT", "CLOSE_SHIFT", "CASH_COUNT"})


def _dependency_result(dependencies, message):
	return {
		"strategy": "blocked",
		"deleted": False,
		"can_delete": False,
		"message": message,
		"dependencies": {
			doctype: {"count": len(names), "names": names} for doctype, names in dependencies.items()
		},
		"affected": [],
		"warnings": [],
	}


def _shift_actions(doc):
	actions = {}
	for filters in (
		{"shift": doc.name},
		{"reference_doctype": "Sales Shift", "reference_document": doc.name},
	):
		for row in frappe.get_all(
			"Cashier Action",
			filters=filters,
			fields=[
				"name",
				"action_type",
				"shift",
				"business_entity",
				"business_point",
				"reference_doctype",
				"reference_document",
			],
			limit_page_length=100000,
		):
			actions[row.name] = row
	technical = []
	business = []
	for row in actions.values():
		owned = (
			row.action_type in SHIFT_TECHNICAL_ACTIONS
			and row.shift == doc.name
			and row.reference_doctype == "Sales Shift"
			and row.reference_document == doc.name
			and row.business_entity == doc.business_entity
			and row.business_point == doc.business_point
		)
		(technical if owned else business).append(row.name)
	return sorted(technical), sorted(business)


def _sales_shift(doc, *, execute=False):
	dependencies = {}
	for doctype, field in (("Sales Receipt", "shift"), ("Cash Movement", "shift")):
		names = _references(doctype, {field: doc.name})
		if names:
			dependencies[doctype] = names
	technical, business = _shift_actions(doc)
	if business:
		dependencies["Cashier Action"] = business
	if dependencies:
		return _dependency_result(dependencies, _("Сначала разберите связанные документы и действия смены"))
	result = {
		"strategy": "hard_delete",
		"deleted": bool(execute),
		"can_delete": True,
		"message": _("Пустая смена и её технические действия будут удалены"),
		"dependencies": {},
		"affected": [{"doctype": "Cashier Action", "name": name} for name in technical],
		"warnings": [],
	}
	if execute:
		for name in technical:
			# This immutable audit DocType rejects generic on_trash. The only
			# exception is an action proven above to belong solely to this
			# empty shift, removed inside the same audited transaction.
			frappe.db.delete("Cashier Action", {"name": name})
		frappe.delete_doc("Sales Shift", doc.name, ignore_permissions=True)
		result["affected"].append({"doctype": "Sales Shift", "name": doc.name, "deleted": True})
	return result


EMPLOYEE_REFERENCES = (
	("Sales Shift", "cashier"),
	("Sales Receipt", "cashier"),
	("Cash Movement", "cashier"),
	("Cashier Action", "cashier"),
	("Stock Receipt", "cashier"),
	("Stock Write Off", "cashier"),
	("Finance Transaction", "employee"),
	("Point Supply Request", "requested_by_employee"),
	("Work Schedule Entry", "employee"),
	("Payroll Run Line", "employee"),
	("Employee Motivation Result", "employee"),
	("Employee Leave", "employee"),
	("Raspechatka User Profile", "linked_employee"),
)


def _employee(doc, *, execute=False):
	references = {}
	for doctype, field in EMPLOYEE_REFERENCES:
		names = _references(doctype, {field: doc.name})
		if names:
			references[doctype] = names
	documents = _references("Employee Document", {"parent": doc.name, "parenttype": "Employee"})
	if documents:
		references["Employee Document"] = documents
	profile = doc.get("system_user_profile")
	user = doc.get("user")
	warnings = []
	if profile or references.get("Raspechatka User Profile"):
		warnings.append(_("Связанный профиль Web OS сохранён; доступ отключается отдельно"))
	if user:
		warnings.append(_("Связанный пользователь сохранён; его доступ отключается отдельно"))
	open_shifts = _references("Sales Shift", {"cashier": doc.name, "status": "Open"})
	if open_shifts:
		blocked = _dependency_result(
			{"Sales Shift": open_shifts}, _("Сначала закройте или удалите открытую смену кассира")
		)
		blocked["warnings"] = warnings
		return blocked
	strategy = "deactivate" if references or profile or user else "hard_delete"
	result = {
		"strategy": strategy,
		"deleted": bool(execute),
		"can_delete": True,
		"message": _("История сохранится; сотрудник будет деактивирован")
		if strategy == "deactivate"
		else _("Неиспользуемый сотрудник будет удалён"),
		"dependencies": {
			doctype: {"count": len(names), "names": names} for doctype, names in references.items()
		},
		"affected": [],
		"warnings": warnings,
	}
	if execute:
		if strategy == "hard_delete":
			frappe.delete_doc("Employee", doc.name, ignore_permissions=True)
			result["affected"] = [{"doctype": "Employee", "name": doc.name, "deleted": True}]
		else:
			doc.active = 0
			doc.pos_access_enabled = 0
			doc.save(ignore_permissions=True)
			result["affected"] = [
				{"doctype": "Employee", "name": doc.name, "active": 0, "pos_access_enabled": 0}
			]
	return result


def _linked_references(doctype, name, *, excluded=()):
	"""Probe declared links, including custom fields, before allowing physical removal.

	Child rows owned by the document itself are removed with their parent; all
	other links, including cancelled historical documents, count as references.
	"""
	references = {}
	for table in ("DocField", "Custom Field"):
		owner_field = "parent" if table == "DocField" else "dt"
		fields = frappe.get_all(
			table, filters={"fieldtype": "Link", "options": doctype}, fields=[owner_field, "fieldname"]
		)
		for field in fields:
			owner = field.get(owner_field)
			if owner in excluded:
				continue
			meta = frappe.get_meta(owner)
			if meta.issingle or getattr(meta, "is_virtual", False):
				continue
			names = [
				row for row in _references(owner, {field.fieldname: name}) if owner != doctype or row != name
			]
			if names:
				references.setdefault(owner, set()).update(names)
	return {key: sorted(names) for key, names in references.items()}


def _master(doc, *, execute=False, allow_hard_delete=False):
	references = _linked_references(doc.doctype, doc.name)
	strategy = "deactivate" if references or not allow_hard_delete else "hard_delete"
	result = {
		"strategy": strategy,
		"deleted": bool(execute),
		"can_delete": True,
		"message": (
			_("Объект деактивирован; история сохранена")
			if execute
			else _("Объект будет деактивирован; история сохранится")
		)
		if strategy == "deactivate"
		else (_("Неиспользуемый объект удалён") if execute else _("Неиспользуемый объект будет удалён")),
		"dependencies": {key: {"count": len(names), "names": names} for key, names in references.items()},
		"affected": [],
		"warnings": [],
	}
	if execute:
		if strategy == "hard_delete":
			frappe.delete_doc(doc.doctype, doc.name, ignore_permissions=True)
			result["affected"].append({"doctype": doc.doctype, "name": doc.name, "deleted": True})
		else:
			doc.active = 0
			doc.save(ignore_permissions=True)
			result["affected"].append({"doctype": doc.doctype, "name": doc.name, "active": 0})
	return result


def _business_point(doc, *, execute=False):
	infrastructure = {}
	for doctype in ("Catalog Warehouse", "POS Workplace", "Cash Register", "POS Connection"):
		infrastructure[doctype] = _references(doctype, {"business_point": doc.name})
	# The infrastructure itself may be referenced by historical rows. Do not
	# treat an empty point as unused just because its own direct links are empty.
	history = _linked_references("Business Point", doc.name, excluded=infrastructure)
	for doctype, names in infrastructure.items():
		for name in names:
			linked = _linked_references(doctype, name, excluded=("Business Point", *infrastructure))
			for key, values in linked.items():
				history.setdefault(key, []).extend(values)
	history = {key: sorted(set(values)) for key, values in history.items()}
	strategy = "deactivate" if history else "hard_delete"
	result = {
		"strategy": strategy,
		"deleted": bool(execute),
		"can_delete": True,
		"message": (
			_("Точка и инфраструктура деактивированы; история сохранена")
			if execute
			else _("Точка и инфраструктура будут деактивированы; история сохранится")
		)
		if history
		else (
			_("Неиспользуемая точка удалена")
			if execute
			else _("Неиспользуемая точка и инфраструктура будут удалены")
		),
		"dependencies": {key: {"count": len(names), "names": names} for key, names in history.items()},
		"affected": [],
		"warnings": [],
	}
	if execute:
		if history:
			doc.active = 0
			doc.save(ignore_permissions=True)
			for doctype, names in infrastructure.items():
				for name in names:
					field = "enabled" if doctype == "POS Connection" else "active"
					frappe.db.set_value(doctype, name, field, 0)
					result["affected"].append({"doctype": doctype, "name": name, field: 0})
		else:
			for doctype in ("POS Connection", "Cash Register", "POS Workplace", "Catalog Warehouse"):
				for name in infrastructure[doctype]:
					frappe.delete_doc(doctype, name, ignore_permissions=True)
					result["affected"].append({"doctype": doctype, "name": name, "deleted": True})
			frappe.delete_doc("Business Point", doc.name, ignore_permissions=True)
		result["affected"].append(
			{"doctype": "Business Point", "name": doc.name, "active": 0}
			if history
			else {"doctype": "Business Point", "name": doc.name, "deleted": True}
		)
	return result


# Only first-party business entities may enter this registry. A client value is
# never passed to frappe.get_doc until it has been resolved through this map.
REGISTRY = {
	"sales_receipt": DeletionRule("Sales Receipt", "page.sales.receipts", "point", _sales_receipt),
	"sales_shift": DeletionRule("Sales Shift", "page.sales.shifts", "point", _sales_shift),
	"cash_movement": DeletionRule("Cash Movement", "page.sales.cash", "point", _cash_movement),
	"stock_receipt": DeletionRule("Stock Receipt", "page.warehouse.receipts", "point", _stock_receipt),
	"stock_write_off": DeletionRule(
		"Stock Write Off", "page.warehouse.write_offs", "point", _stock_write_off
	),
	"stock_inventory": DeletionRule(
		"Stock Inventory", "page.warehouse.inventories", "point", _stock_inventory
	),
	"purchase_order": DeletionRule(
		"Purchase Order", "page.warehouse.purchase_orders", "point", _purchase_order
	),
	"employee": DeletionRule("Employee", "page.team.employees", "entity", _employee),
	"business_point": DeletionRule("Business Point", "page.references.points", "point_self", _business_point),
	"catalog_warehouse": DeletionRule(
		"Catalog Warehouse", "page.references.warehouses", "point", partial(_master, allow_hard_delete=True)
	),
	"cash_register": DeletionRule(
		"Cash Register", "page.sales.integration", "point", partial(_master, allow_hard_delete=True)
	),
	"pos_workplace": DeletionRule(
		"POS Workplace", "page.sales.integration", "point", partial(_master, allow_hard_delete=True)
	),
	"catalog_item": DeletionRule(
		"Catalog Item", "page.catalog", "network", partial(_master, allow_hard_delete=True)
	),
	"catalog_supplier": DeletionRule(
		"Catalog Supplier", "page.references.suppliers", "supplier", partial(_master, allow_hard_delete=True)
	),
	"client": DeletionRule(
		"Client", "page.references.clients", "client", partial(_master, allow_hard_delete=True)
	),
	"business_entity": DeletionRule(
		"Business Entity", "page.references.entities", "entity", partial(_master, allow_hard_delete=True)
	),
	"organization": DeletionRule(
		"Organization", "page.references.organizations", "network", partial(_master, allow_hard_delete=True)
	),
}


def _resolve(entity_type, name, *, lock=False):
	rule = REGISTRY.get(entity_type)
	if not rule:
		frappe.throw(
			_("Для этого типа сущности безопасное удаление ещё не реализовано"), frappe.PermissionError
		)
	require_access(rule.area, "delete")
	if not isinstance(name, str) or not name.strip():
		frappe.throw(_("Укажите объект"))
	# The lock serializes competing deletion requests on this object. Preview
	# intentionally uses the same lookup and scope path without taking a lock.
	if lock:
		frappe.db.sql(
			"select name from `tab" + rule.doctype + "` where name=%s for update",
			(name,),
		)
	doc = frappe.get_doc(rule.doctype, name)
	if rule.scope == "point_self":
		ensure_point_allowed(doc.name, getattr(doc, "business_entity", None))
	elif rule.scope == "point":
		ensure_point_allowed(doc.business_point, getattr(doc, "business_entity", None))
	elif rule.scope == "entity":
		ensure_entity_allowed(doc.business_entity if rule.doctype != "Business Entity" else doc.name)
	elif rule.scope == "supplier":
		if doc.business_entity:
			ensure_entity_allowed(doc.business_entity)
		elif not get_scope().get("global"):
			frappe.throw(_("Общесетевой поставщик недоступен"), frappe.PermissionError)
	elif rule.scope == "client":
		if doc.registration_point:
			ensure_point_allowed(doc.registration_point)
		elif not get_scope().get("global"):
			frappe.throw(_("Клиент без точки регистрации недоступен"), frappe.PermissionError)
	elif rule.scope == "network":
		if not get_scope().get("global"):
			frappe.throw(_("Общесетевой объект недоступен"), frappe.PermissionError)
	else:
		frappe.throw(_("Неизвестное правило области доступа"), frappe.PermissionError)
	return rule, doc


def dependency_counts(doctype, field, name, *, docstatus=None):
	"""Explicit dependency probe; callers must name the exact linked field."""
	filters = {field: name}
	if docstatus is not None:
		filters["docstatus"] = docstatus
	return frappe.db.count(doctype, filters)


def _preview(entity_type, name):
	rule, doc = _resolve(entity_type, name)
	return rule.handler(doc, execute=False)


@frappe.whitelist(methods=["GET"])
@access_contract(auth="current_user", action="delete", scope="point")
def get_delete_preview(entity_type, name):
	if frappe.session.user == "Guest":
		frappe.throw(_("Требуется авторизация"), frappe.AuthenticationError)
	return _preview(entity_type, name)


@frappe.whitelist(methods=["POST"])
@access_contract(auth="current_user", action="delete", scope="point")
def delete_entity(entity_type, name, reason=None):
	if frappe.session.user == "Guest":
		frappe.throw(_("Требуется авторизация"), frappe.AuthenticationError)
	authorized = False
	strategy = "blocked"
	try:
		rule, doc = _resolve(entity_type, name, lock=True)
		authorized = True
		preview = rule.handler(doc, execute=False)
		strategy = preview["strategy"]
		if not preview["can_delete"]:
			result = preview
		else:
			result = rule.handler(doc, execute=True)
			source = _external_source(doc)
			if result.get("deleted") and doc.get("external_id") and source:
				suppress_external_event(source, doc.external_id, entity_type, name)
		_audit(
			entity_type,
			name,
			reason,
			result["strategy"],
			result.get("affected", []),
			"Applied" if result.get("deleted") else "Blocked",
		)
		return result
	except Exception:
		frappe.db.rollback()
		if authorized:
			# A failed domain transaction cannot contain its own durable audit.
			# Record the diagnostic in a separate transaction after rollback.
			try:
				_audit(entity_type, name, reason, strategy, [], "Failed")
				frappe.db.commit()
			except Exception:
				frappe.db.rollback()
		raise


def _audit(entity_type, name, reason, strategy, affected, outcome):
	frappe.get_doc(
		{
			"doctype": "Admin Deletion Audit",
			"actor": frappe.session.user,
			"entity_type": entity_type,
			"entity_name": name,
			"strategy": strategy,
			"occurred_at": now_datetime(),
			"reason": reason,
			"affected_json": frappe.as_json(affected),
			"outcome": outcome,
		}
	).insert(ignore_permissions=True)


EXTERNAL_SOURCES = frozenset({"POS", "MoySklad"})


def _external_source(doc):
	source = doc.get("source")
	if source == "MoySklad Opening Balance":
		return "MoySklad"
	return source if source in EXTERNAL_SOURCES else None


def suppress_external_event(source, external_id, entity_type, entity_name):
	"""Persist in the same transaction as the domain action; unique source/id."""
	if source not in EXTERNAL_SOURCES or not external_id:
		frappe.throw(_("Неизвестный внешний источник"), frappe.ValidationError)
	from hashlib import sha256

	key = sha256(f"{source}\0{external_id}".encode()).hexdigest()
	if not frappe.db.exists("External Event Suppression", key):
		frappe.get_doc(
			{
				"doctype": "External Event Suppression",
				"key": key,
				"source": source,
				"external_id": external_id,
				"entity_type": entity_type,
				"entity_name": entity_name,
				"actor": frappe.session.user,
				"occurred_at": now_datetime(),
			}
		).insert(ignore_permissions=True)


def is_external_event_suppressed(source, external_id):
	if source not in EXTERNAL_SOURCES or not external_id:
		return False
	from hashlib import sha256

	key = sha256(f"{source}\0{external_id}".encode()).hexdigest()
	return bool(frappe.db.exists("External Event Suppression", key))
