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


def _references(doctype, filters):
    return frappe.get_all(doctype, filters=filters, pluck="name", limit_page_length=100000)


def _dependency_probe(doc):
    """Only explicit business dependencies are considered safe to inspect here."""
    dependencies = {}
    if doc.doctype == "Sales Receipt":
        if doc.receipt_type == "Sale":
            returns = _references("Sales Receipt", {
                "original_receipt": doc.name, "receipt_type": "Return", "docstatus": 1,
            })
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
            allocations = _references("Supplier Payment Allocation", {
                "finance_transaction": ["in", transactions],
            })
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
        for name in _references("Stock Ledger Entry", {
            "voucher_type": doc.doctype, "voucher_no": doc.name, "is_reversal": 1,
        }):
            affected.append({"doctype": "Stock Ledger Entry", "name": name})
    if doc.doctype == "Sales Receipt":
        for name in _references("Profitability Entry", {
            "source_doctype": doc.doctype, "source_document": doc.name,
        }):
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
            "strategy": "blocked", "deleted": False, "can_delete": False,
            "message": _("Документ уже отменён или имеет неподдерживаемый статус"),
            "dependencies": {}, "affected": [], "warnings": [],
        }
    dependencies = _dependency_probe(doc)
    if dependencies:
        return {
            "strategy": "blocked", "deleted": False, "can_delete": False,
            "message": _("Сначала отмените или удалите зависимые документы"),
            "dependencies": {doctype: {"count": len(names), "names": names}
                             for doctype, names in dependencies.items()},
            "affected": [], "warnings": [],
        }
    strategy = "hard_delete" if doc.docstatus == 0 else "cancel"
    result = {
        "strategy": strategy, "deleted": bool(execute), "can_delete": True,
        "message": _("Черновик будет удалён") if strategy == "hard_delete"
                   else _("Документ будет отменён; история сохранится"),
        "dependencies": {}, "affected": [], "warnings": [],
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


# Only first-party business entities may enter this registry. A client value is
# never passed to frappe.get_doc until it has been resolved through this map.
REGISTRY = {
    "sales_receipt": DeletionRule("Sales Receipt", "page.sales.receipts", "point", _sales_receipt),
    "sales_shift": DeletionRule("Sales Shift", "page.sales.shifts", "point", _blocked),
    "cash_movement": DeletionRule("Cash Movement", "page.sales.cash", "point", _cash_movement),
    "stock_receipt": DeletionRule("Stock Receipt", "page.warehouse.receipts", "point", _stock_receipt),
    "stock_write_off": DeletionRule("Stock Write Off", "page.warehouse.write_offs", "point", _stock_write_off),
    "stock_inventory": DeletionRule("Stock Inventory", "page.warehouse.inventories", "point", _stock_inventory),
    "purchase_order": DeletionRule("Purchase Order", "page.warehouse.purchase_orders", "point", _purchase_order),
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
        _audit(entity_type, name, reason, result["strategy"], result.get("affected", []),
               "Applied" if result.get("deleted") else "Blocked")
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
    frappe.get_doc({
        "doctype": "Admin Deletion Audit",
        "actor": frappe.session.user,
        "entity_type": entity_type,
        "entity_name": name,
        "strategy": strategy,
        "occurred_at": now_datetime(),
        "reason": reason,
        "affected_json": frappe.as_json(affected),
        "outcome": outcome,
    }).insert(ignore_permissions=True)


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
