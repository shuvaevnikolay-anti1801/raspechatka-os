"""Admin deletion boundary. Domain strategies are registered explicitly in later DEV-181 parts."""
from dataclasses import dataclass

import frappe
from frappe import _
from frappe.utils import now_datetime

from raspechatka.access import require_access
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


# Only first-party business entities may enter this registry. A client value is
# never passed to frappe.get_doc until it has been resolved through this map.
REGISTRY = {
    "sales_receipt": DeletionRule("Sales Receipt", "page.sales.receipts", "point", _blocked),
    "sales_shift": DeletionRule("Sales Shift", "page.sales.shifts", "point", _blocked),
    "cash_movement": DeletionRule("Cash Movement", "page.sales.cash", "point", _blocked),
    "stock_receipt": DeletionRule("Stock Receipt", "page.warehouse.receipts", "point", _blocked),
    "stock_write_off": DeletionRule("Stock Write Off", "page.warehouse.write_offs", "point", _blocked),
    "stock_inventory": DeletionRule("Stock Inventory", "page.warehouse.inventories", "point", _blocked),
    "purchase_order": DeletionRule("Purchase Order", "page.warehouse.purchase_orders", "entity", _blocked),
    "employee": DeletionRule("Employee", "page.team.employees", "entity", _blocked),
    "business_point": DeletionRule("Business Point", "page.sales.overview", "point_self", _blocked),
}


def _resolve(entity_type, name, *, lock=False):
    rule = REGISTRY.get(entity_type)
    if not rule:
        frappe.throw(_("Для этого типа сущности безопасное удаление ещё не реализовано"), frappe.PermissionError)
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
    try:
        rule, doc = _resolve(entity_type, name, lock=True)
        preview = rule.handler(doc, execute=False)
        if not preview["can_delete"]:
            result = preview
        else:
            result = rule.handler(doc, execute=True)
            source = _external_source(doc)
            if result.get("deleted") and doc.get("external_id") and source:
                suppress_external_event(source, doc.external_id, entity_type, name)
        frappe.get_doc({
            "doctype": "Admin Deletion Audit",
            "actor": frappe.session.user,
            "entity_type": entity_type,
            "entity_name": name,
            "strategy": result["strategy"],
            "occurred_at": now_datetime(),
            "reason": reason,
            "affected_json": frappe.as_json(result.get("affected", [])),
            "outcome": "Applied" if result.get("deleted") else "Blocked",
        }).insert(ignore_permissions=True)
        return result
    except Exception:
        frappe.db.rollback()
        raise


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
        frappe.get_doc({
            "doctype": "External Event Suppression",
            "key": key,
            "source": source,
            "external_id": external_id,
            "entity_type": entity_type,
            "entity_name": entity_name,
            "actor": frappe.session.user,
            "occurred_at": now_datetime(),
        }).insert(ignore_permissions=True)


def is_external_event_suppressed(source, external_id):
    if source not in EXTERNAL_SOURCES or not external_id:
        return False
    from hashlib import sha256
    key = sha256(f"{source}\0{external_id}".encode()).hexdigest()
    return bool(frappe.db.exists("External Event Suppression", key))
